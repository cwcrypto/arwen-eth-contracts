import { TestSigningService } from './common';
// Setup web3 provider to point at local development blockchain spawned by truffle develop
import Web3 from 'web3';
const web3 = new Web3('http://localhost:9545');

// Import truffle contract abstractions
const Escrow = artifacts.require("Escrow");
const EthEscrow = artifacts.require("EthEscrow");
const Erc20Escrow = artifacts.require("Erc20Escrow");
const TestToken = artifacts.require("TestToken");

import { EthEscrowInstance, Erc20EscrowInstance, TestTokenInstance } from './../types/truffle-contracts/index.d';
import { fail } from 'assert';
import { BigNumber } from "bignumber.js";
import { TransactionReceipt } from 'web3-core';
import { getCurrentTimeUnixEpoch } from './common';

/* Helpers */

const PRINT_GAS_USAGE = false;
function PrintGasUsage(func: string, receipt: TransactionReceipt) {
    if(PRINT_GAS_USAGE) {
        console.log(`${func} took ${printGasCost(receipt.gasUsed)}`);
    }
}

function printGasCost(gasUsed: number) {
    // assuiming gas price of 2 Gwei
    // For up-to-date gas prices see: https://ethgasstation.info/
    let gasPrice = web3.utils.toBN(2 * 1000 * 1000 * 1000);

    let ethPrice = web3.utils.fromWei(gasPrice.mul(web3.utils.toBN(gasUsed)), "ether");
    return `gas used ${gasUsed}: ${ethPrice} ETH`;
}

/**
 * Escrow state enum matching the Escrow.sol internal state machine
 */
enum EscrowState { UNFUNDED, OPEN, PUZZLE_POSTED, CLOSED }

contract('EthEscrow', async (accounts) => {
    var totalGasUsed = 0;
    var mainAccount = web3.utils.toChecksumAddress(accounts[0]);
    var TSS: TestSigningService;

    beforeEach(async () => {
        // generate fresh accounts to use for every test
        TSS = new TestSigningService();
        totalGasUsed = 0;
    });

    afterEach(() => {
        console.log(`total ${printGasCost(totalGasUsed)}\n`);
    });

    /** 
     * Helper method that creates a new EthEscrow contract instance.
     * Automatically uses the escrower/payee keys generated for the current
     * test.
     * @param escrowAmount The amount to send to this escrow
     * @param escrowTimelock The refund timelock of this escrow
     */
    async function setupEthEscrow(escrowAmount: number, escrowTimelock: number) : Promise<EthEscrowInstance> {
        var escrow = await EthEscrow.new( 
            [ TSS.eReserve.address, TSS.eTrade.address, TSS.eRefund.address ],
            [ TSS.pReserve.address, TSS.pTrade.address ],
            escrowTimelock,
            { from: mainAccount, value: escrowAmount}
        );
        var receipt = await web3.eth.getTransactionReceipt(escrow.transactionHash);
        PrintGasUsage("EthEscrow constructor", receipt);
        totalGasUsed += receipt.gasUsed;

        assert.isTrue(new BigNumber(escrowAmount).isEqualTo(await escrow.escrowAmount()), "escrow amount");
        return escrow;
    }

    /**
     * Attempts to withdraw any available balances for the escrower or payee in
     * the escrow and records the gas used by calling the withdraw methods
     */
    async function withdrawBalances(escrow: EthEscrowInstance) {
        let escrowerBalance = await escrow.escrowerBalance();
        if( escrowerBalance.toNumber() > 0) {
            let txResult = await escrow.withdrawEscrowerFunds();
            totalGasUsed += txResult.receipt.gasUsed;
        }

        let payeeBalance = await escrow.payeeBalance();
        if( payeeBalance.toNumber() > 0) {
            let txResult = await escrow.withdrawPayeeFunds();
            totalGasUsed += txResult.receipt.gasUsed;
        }
    }

    it("Test cashout escrow", async () => {
        var escrow = await setupEthEscrow(1000, getCurrentTimeUnixEpoch());
        var { eSig, pSig } = TSS.signCashout(escrow.address, 400);
        var txResult = await escrow.cashout(400, eSig.v, eSig.r, eSig.s, pSig.v, pSig.r, pSig.s);
        PrintGasUsage("cashout", txResult.receipt);
        totalGasUsed += txResult.receipt.gasUsed;

        await withdrawBalances(escrow);
        assert.equal(await web3.eth.getBalance(TSS.eReserve.address), "600");
        assert.equal(await web3.eth.getBalance(TSS.pReserve.address), "400");
        assert.equal((await escrow.escrowState()).toNumber(), EscrowState.CLOSED);
    });

    it("Test refund escrow before expiry", async () => {
        var escrowNotExpired = await setupEthEscrow(1000, getCurrentTimeUnixEpoch() + 24 * 60 * 60 );
        var eSig = TSS.signEscrowRefund(escrowNotExpired.address, 400);
        try {
            await escrowNotExpired.refund(400, eSig.v, eSig.r, eSig.s);
            fail("Refunding escrow before it has expired should fail");
        } catch(err) {
            assert.match(err, new RegExp("Timelock not reached"));
        }
    });

    it("Test refund expired escrow", async () => {
        var expiredEscrow = await setupEthEscrow(1000, getCurrentTimeUnixEpoch());
        var eSig = TSS.signEscrowRefund(expiredEscrow.address, 400);
        var txResult = await expiredEscrow.refund(400, eSig.v, eSig.r, eSig.s);
        PrintGasUsage("refund", txResult.receipt);
        totalGasUsed += txResult.receipt.gasUsed;

        await withdrawBalances(expiredEscrow);
        assert.equal(await web3.eth.getBalance(TSS.eReserve.address), "600");
        assert.equal(await web3.eth.getBalance(TSS.pReserve.address), "400");
        assert.equal((await expiredEscrow.escrowState()).toNumber(), EscrowState.CLOSED);
    });

    it("Test postPuzzle before expiry, refundPuzzle fails, solvePuzzle works", async () => {
        var escrow = await setupEthEscrow(1000, getCurrentTimeUnixEpoch());
        
        var preimage = web3.utils.keccak256("test preimage");
        var puzzle = web3.utils.keccak256(preimage);
        var puzzleTimelock = getCurrentTimeUnixEpoch() + 24 * 60 * 60 ; // set puzzle timelock 1 day from now
        var { eSig, pSig } = TSS.signPuzzle(escrow.address, 200, 200, puzzle, puzzleTimelock);

        var txResult = await escrow.postPuzzle(200, 200, puzzle, puzzleTimelock, eSig.v, eSig.r, eSig.s, pSig.v, pSig.r, pSig.s);
        PrintGasUsage("postPuzzle", txResult.receipt);
        totalGasUsed += txResult.receipt.gasUsed;

        // State assertions after puzzle has been posted
        await withdrawBalances(escrow);
        assert.equal(await web3.eth.getBalance(TSS.eReserve.address), "600");
        assert.equal(await web3.eth.getBalance(TSS.pReserve.address), "200");
        assert.equal((await escrow.escrowState()).toNumber(), EscrowState.PUZZLE_POSTED);

        // Refunding the puzzle should fail because we have not yet hit the timelock
        try {
            await escrow.refundPuzzle();
            fail("Refunding puzzle before it has expired should fail");
        } catch(err) {
            assert.match(err, new RegExp("Timelock not reached"));
        }

        // Solving the puzzle with the correct preimage should succeed and release the tradeAmount to the payee 
        var txResult = await escrow.solvePuzzle(preimage);
        PrintGasUsage("solvePuzzle", txResult.receipt);
        totalGasUsed += txResult.receipt.gasUsed;

        await withdrawBalances(escrow);
        assert.equal(await web3.eth.getBalance(TSS.pReserve.address), "400");
        assert.equal((await escrow.escrowState()).toNumber(), EscrowState.CLOSED);
    });

    it("Test postPuzzle after expiry, refundPuzzle works", async () => {
        var escrow = await setupEthEscrow(1000, getCurrentTimeUnixEpoch());
        
        var preimage = web3.utils.keccak256("test preimage");
        var puzzle = web3.utils.keccak256(preimage);
        var puzzleTimelock = getCurrentTimeUnixEpoch(); // set puzzle timelock to now

       var { eSig, pSig } = TSS.signPuzzle(escrow.address, 200, 200, puzzle, puzzleTimelock);
        
        var txResult = await escrow.postPuzzle(200, 200, puzzle, puzzleTimelock, eSig.v, eSig.r, eSig.s, pSig.v, pSig.r, pSig.s);
        PrintGasUsage("postPuzzle", txResult.receipt);
        totalGasUsed += txResult.receipt.gasUsed;

        // State assertions after puzzle has been posted
        await withdrawBalances(escrow);
        assert.equal(await web3.eth.getBalance(TSS.eReserve.address), "600");
        assert.equal(await web3.eth.getBalance(TSS.pReserve.address), "200");
        assert.equal((await escrow.escrowState()).toNumber(), EscrowState.PUZZLE_POSTED);

        // Refunding the puzzle should succeed and release the tradeAmount back to the escrower 
        var txResult = await escrow.refundPuzzle();
        PrintGasUsage("refundPuzzle", txResult.receipt);
        totalGasUsed += txResult.receipt.gasUsed;

        await withdrawBalances(escrow);
        assert.equal(await web3.eth.getBalance(TSS.eReserve.address), "800");
        assert.equal((await escrow.escrowState()).toNumber(), EscrowState.CLOSED);
    });
});

contract('Erc20Escrow', async (accounts) => {
    var mainAccount = web3.utils.toChecksumAddress(accounts[0]);
    var totalGasUsed = 0;
    var testToken: TestTokenInstance;
    var TSS: TestSigningService;

    beforeEach(async () => {
        // generate fresh accounts to use for every test
        totalGasUsed = 0;
        TSS = new TestSigningService();
        // Create a test erc20 token with an initial balance minted to the mainAccount
        testToken = await TestToken.new({from: mainAccount});
    });

    afterEach(() => {
        console.log(`total ${printGasCost(totalGasUsed)}\n`);
    });

    /** 
     * Helper method that creates a new Erc20Escrow contract instance.
     * Automatically uses the escrower/payee keys generated for the current
     * test. Funds the Erc20Escrow after it is created.
     * @param escrowAmount The amount to send to this escrow
     * @param escrowTimelcok The refund timelock of this escrow
     */
    async function setupERC20Escrow(escrowAmount: number, escrowTimelock: number) : Promise<Erc20EscrowInstance> {
        var escrow = await Erc20Escrow.new(
            testToken.address,
            escrowAmount,
            [ TSS.eReserve.address, TSS.eTrade.address, TSS.eRefund.address ],
            [ TSS.pReserve.address, TSS.pTrade.address ],
            escrowTimelock,
            { from: mainAccount }
        );

        let receipt = await web3.eth.getTransactionReceipt(escrow.transactionHash);
        PrintGasUsage("ERC20Escrow constructor", receipt);
        totalGasUsed += receipt.gasUsed;
        
        // Approve escrow contract to transfer the tokens on behalf of mainAccount
        var txResult = await testToken.approve(escrow.address, escrowAmount, {from: mainAccount});
        PrintGasUsage("ERC20 token approve", txResult.receipt);
        totalGasUsed += txResult.receipt.gasUsed;

        txResult = await escrow.fundEscrow(mainAccount);
        PrintGasUsage("fundEscrow", txResult.receipt);
        totalGasUsed += txResult.receipt.gasUsed;

        assert.isTrue(new BigNumber(escrowAmount).isEqualTo(await escrow.escrowAmount()), "escrow amount");
        assert.equal((await escrow.escrowState()).toNumber(), EscrowState.OPEN);
        return escrow;
    }

    it("Test cashout escrow", async () => {
        var erc20Escrow = await setupERC20Escrow(1000, getCurrentTimeUnixEpoch());
        var { eSig, pSig } = TSS.signCashout(erc20Escrow.address, 400);
        var txResult = await erc20Escrow.cashout(400, eSig.v, eSig.r, eSig.s, pSig.v, pSig.r, pSig.s);
        PrintGasUsage("cashout", txResult.receipt);
        totalGasUsed += txResult.receipt.gasUsed;

        assert.isTrue(new BigNumber(600).isEqualTo(await testToken.balanceOf(TSS.eReserve.address)));
        assert.isTrue(new BigNumber(400).isEqualTo(await testToken.balanceOf(TSS.pReserve.address)));
        assert.equal((await erc20Escrow.escrowState()).toNumber(), EscrowState.CLOSED);
    });

    it("Test refund escrow before expiry", async () => {
        var escrowNotExpired = await setupERC20Escrow(1000, getCurrentTimeUnixEpoch() + 24 * 60 * 60 );
        var eSig = TSS.signEscrowRefund(escrowNotExpired.address, 400);
        try {
            await escrowNotExpired.refund(400, eSig.v, eSig.r, eSig.s);
            fail("Refunding escrow before it has expired should fail");
        } catch(err) {
            assert.match(err, new RegExp("Timelock not reached"));
        }
    });

    it("Test refund expired escrow", async () => {
        var expiredEscrow = await setupERC20Escrow(1000, getCurrentTimeUnixEpoch());
        var eSig = TSS.signEscrowRefund(expiredEscrow.address, 400);
        var txResult = await expiredEscrow.refund(400, eSig.v, eSig.r, eSig.s);
        PrintGasUsage("refund", txResult.receipt);
        totalGasUsed += txResult.receipt.gasUsed;

        assert.isTrue(new BigNumber(600).isEqualTo(await testToken.balanceOf(TSS.eReserve.address)));
        assert.isTrue(new BigNumber(400).isEqualTo(await testToken.balanceOf(TSS.pReserve.address)));
        assert.equal((await expiredEscrow.escrowState()).toNumber(), EscrowState.CLOSED);
    });

    it("Test postPuzzle before expiry, refundPuzzle fails, solvePuzzle works", async () => {
        var escrow = await setupERC20Escrow(1000, getCurrentTimeUnixEpoch());
        
        var preimage = web3.utils.keccak256("test preimage");
        var puzzle = web3.utils.keccak256(preimage);
        var puzzleTimelock = getCurrentTimeUnixEpoch() + 24 * 60 * 60 ; // set puzzle timelock 1 day from now
        var { eSig, pSig } = TSS.signPuzzle(escrow.address, 200, 200, puzzle, puzzleTimelock);

        var txResult = await escrow.postPuzzle(200, 200, puzzle, puzzleTimelock, eSig.v, eSig.r, eSig.s, pSig.v, pSig.r, pSig.s);
        PrintGasUsage("postPuzzle", txResult.receipt);
        totalGasUsed += txResult.receipt.gasUsed;

        // State assertions after puzzle has been posted
        assert.isTrue(new BigNumber(600).isEqualTo(await testToken.balanceOf(TSS.eReserve.address)));
        assert.isTrue(new BigNumber(200).isEqualTo(await testToken.balanceOf(TSS.pReserve.address)));
        assert.equal((await escrow.escrowState()).toNumber(), EscrowState.PUZZLE_POSTED);

        // Refunding the puzzle should fail because we have not yet hit the timelock
        try {
            await escrow.refundPuzzle();
            fail("Refunding puzzle before it has expired should fail");
        } catch(err) {
            assert.match(err, new RegExp("Timelock not reached"));
        }

        // Solving the puzzle with the correct preimage should succeed and release the tradeAmount to the payee 
        var txResult = await escrow.solvePuzzle(preimage);
        PrintGasUsage("solvePuzzle", txResult.receipt);
        totalGasUsed += txResult.receipt.gasUsed;

        assert.isTrue(new BigNumber(400).isEqualTo(await testToken.balanceOf(TSS.pReserve.address)));
        assert.equal((await escrow.escrowState()).toNumber(), EscrowState.CLOSED);
    });

    it("Test postPuzzle after expiry, refundPuzzle works", async () => {
        var escrow = await setupERC20Escrow(1000, getCurrentTimeUnixEpoch());
        
        var preimage = web3.utils.keccak256("test preimage");
        var puzzle = web3.utils.keccak256(preimage);
        var puzzleTimelock = getCurrentTimeUnixEpoch(); // set puzzle timelock to now

       var { eSig, pSig } = TSS.signPuzzle(escrow.address, 200, 200, puzzle, puzzleTimelock);
        
        var txResult = await escrow.postPuzzle(200, 200, puzzle, puzzleTimelock, eSig.v, eSig.r, eSig.s, pSig.v, pSig.r, pSig.s);
        PrintGasUsage("postPuzzle", txResult.receipt);
        totalGasUsed += txResult.receipt.gasUsed;

        // State assertions after puzzle has been posted
        assert.isTrue(new BigNumber(600).isEqualTo(await testToken.balanceOf(TSS.eReserve.address)));
        assert.isTrue(new BigNumber(200).isEqualTo(await testToken.balanceOf(TSS.pReserve.address)));
        assert.equal((await escrow.escrowState()).toNumber(), EscrowState.PUZZLE_POSTED);

        // Refunding the puzzle should succeed and release the tradeAmount back to the escrower 
        var txResult = await escrow.refundPuzzle();
        PrintGasUsage("refundPuzzle", txResult.receipt);
        totalGasUsed += txResult.receipt.gasUsed;

        assert.isTrue(new BigNumber(800).isEqualTo(await testToken.balanceOf(TSS.eReserve.address)));
        assert.equal((await escrow.escrowState()).toNumber(), EscrowState.CLOSED);
    });
});