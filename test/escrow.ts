// Setup web3 provider to point at local development blockchain spawned by truffle develop
import Web3 = require('web3');
const web3 = new Web3('http://localhost:9545');

// Import truffle contract abstractions
const Escrow = artifacts.require("Escrow");
const EthEscrow = artifacts.require("EthEscrow");
const Erc20Escrow = artifacts.require("Erc20Escrow");
const TestToken = artifacts.require("TestToken");

import { EthEscrowInstance, Erc20EscrowInstance, TestTokenInstance } from './../types/truffle-contracts/index.d';
import { Account, MessageSignature } from 'web3/eth/accounts';
import { fail } from 'assert';
import { BigNumber } from "bignumber.js";
import { TransactionReceipt } from 'web3/types';

/* Globals */
var eReserve: Account, eTrade: Account, eRefund: Account;
var pReserve: Account, pTrade: Account;

/* Helpers */

const PRINT_GAS_USAGE = false;
function PrintGasUsage(func: string, receipt: TransactionReceipt) {
    if(PRINT_GAS_USAGE) {
        console.log(`${func} took ${receipt.gasUsed} gas`);
    }
}

function getCurrentTimeUnixEpoch() {
    return Math.floor(new Date().valueOf() / 1000)
}

function generateNewAccounts() {
    eReserve = web3.eth.accounts.create();
    eTrade = web3.eth.accounts.create();
    eRefund = web3.eth.accounts.create();
    pReserve = web3.eth.accounts.create();
    pTrade = web3.eth.accounts.create();
}

interface DuoSigned { eSig: MessageSignature, pSig: MessageSignature };

/**
 * Sign methods will automatically add the message prefix
 * "\x19Ethereum Signed Message:\n" + message.length
 * https://web3js.readthedocs.io/en/1.0/web3-eth-accounts.html#sign
 */

function signCashout(addr: string, escrowAmt: number, payeeAmt: number): DuoSigned {
    var types = ['address', 'uint256', 'uint256'];
    var values = [addr, escrowAmt, payeeAmt];
    var message = web3.eth.abi.encodeParameters(types, values);
    var digest = web3.utils.keccak256(message);
    return {
        eSig: eTrade.sign(digest),
        pSig: pTrade.sign(digest)
    };
}

function signEscrowRefund(addr: string, escrowAmt: number, payeeAmt: number): MessageSignature {
    var types = ['address', 'uint256', 'uint256'];
    var values = [addr, escrowAmt, payeeAmt];
    var message = web3.eth.abi.encodeParameters(types, values);
    var digest = web3.utils.keccak256(message);
    return eRefund.sign(digest);
}

function signPuzzle(addr: string, escrowAmt: number, payeeAmt: number, tradeAmt: number, puzzle: string, timelock: number): DuoSigned {
    var types = ['address', 'uint256', 'uint256', 'uint256', 'bytes32', 'uint256'];
    var values = [addr, escrowAmt, payeeAmt, tradeAmt, puzzle, timelock];
    var message = web3.eth.abi.encodeParameters(types, values);
    var digest = web3.utils.keccak256(message);
    return {
        eSig: eTrade.sign(digest),
        pSig: pTrade.sign(digest)
    };
}

/**
 * Escrow state enum matching the Escrow.sol internal state machine
 */
enum EscrowState { UNFUNDED, OPEN, PUZZLE_POSTED, CLOSED }

contract('EthEscrow', async (accounts) => {
    var totalGasUsed = 0;
    var mainAccount = web3.utils.toChecksumAddress(accounts[0]);

    beforeEach(async () => {
        // generate fresh accounts to use for every test
        generateNewAccounts();
        totalGasUsed = 0;
    });

    afterEach(() => {
        console.log("total gas used: " + totalGasUsed);
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
            [ eReserve.address, eTrade.address, eRefund.address ],
            [ pReserve.address, pTrade.address ],
            escrowTimelock,
            { from: mainAccount, value: escrowAmount}
        );
        var receipt = await web3.eth.getTransactionReceipt(escrow.transactionHash);
        PrintGasUsage("EthEscrow constructor", receipt);
        totalGasUsed += receipt.gasUsed;

        assert.isTrue(new BigNumber(escrowAmount).isEqualTo(await escrow.escrowAmount()), "escrow amount");
        return escrow;
    }

    it("Test verify signature", async () => {
        var escrow = await setupEthEscrow(1000, getCurrentTimeUnixEpoch());
        var h = web3.utils.keccak256("test message");
        var eSig = eTrade.sign(h);
        var addr = await escrow.verify(h, eSig.v, eSig.r, eSig.s);
        assert.equal(addr, eTrade.address, "verify address");
    });

    it("Test cashout escrow", async () => {
        var ethEscrow = await setupEthEscrow(1000, getCurrentTimeUnixEpoch());
        var { eSig, pSig } = signCashout(ethEscrow.address, 600, 400);
        var txResult = await ethEscrow.cashout(600, 400, eSig.v, eSig.r, eSig.s, pSig.v, pSig.r, pSig.s);
        PrintGasUsage("cashout", txResult.receipt);
        totalGasUsed += txResult.receipt.gasUsed;

        assert.equal(await web3.eth.getBalance(eReserve.address), web3.utils.toBN(600));
        assert.equal(await web3.eth.getBalance(pReserve.address), web3.utils.toBN(400));
        assert.equal((await ethEscrow.escrowState()).toNumber(), EscrowState.CLOSED);
    });

    it("Test refund escrow before expiry", async () => {
        var escrowNotExpired = await setupEthEscrow(1000, getCurrentTimeUnixEpoch() + 24 * 60 * 60 );
        var eSig = signEscrowRefund(escrowNotExpired.address, 600, 400);
        try {
            await escrowNotExpired.refund(600, 400, eSig.v, eSig.r, eSig.s);
            fail("Refunding escrow before it has expired should fail");
        } catch(err) {
            assert.match(err, new RegExp("Timelock not reached"));
        }
    });

    it("Test refund expired escrow", async () => {
        var expiredEscrow = await setupEthEscrow(1000, getCurrentTimeUnixEpoch());
        var eSig = signEscrowRefund(expiredEscrow.address, 600, 400);
        var txResult = await expiredEscrow.refund(600, 400, eSig.v, eSig.r, eSig.s);
        PrintGasUsage("refund", txResult.receipt);
        totalGasUsed += txResult.receipt.gasUsed;

        assert.equal(await web3.eth.getBalance(eReserve.address), web3.utils.toBN(600));
        assert.equal(await web3.eth.getBalance(pReserve.address), web3.utils.toBN(400));
        assert.equal((await expiredEscrow.escrowState()).toNumber(), EscrowState.CLOSED);
    });

    it("Test postPuzzle before expiry, refundPuzzle fails, solvePuzzle works", async () => {
        var escrow = await setupEthEscrow(1000, getCurrentTimeUnixEpoch());
        
        var preimage = web3.utils.keccak256("test preimage");
        var puzzle = web3.utils.keccak256(preimage);
        var puzzleTimelock = getCurrentTimeUnixEpoch() + 24 * 60 * 60 ; // set puzzle timelock 1 day from now
        var { eSig, pSig } = signPuzzle(escrow.address, 600, 200, 200, puzzle, puzzleTimelock);

        var txResult = await escrow.postPuzzle(600, 200, 200, puzzle, puzzleTimelock, eSig.v, eSig.r, eSig.s, pSig.v, pSig.r, pSig.s);
        PrintGasUsage("postPuzzle", txResult.receipt);
        totalGasUsed += txResult.receipt.gasUsed;

        // State assertions after puzzle has been posted
        assert.equal(await web3.eth.getBalance(eReserve.address), web3.utils.toBN(600));
        assert.equal(await web3.eth.getBalance(pReserve.address), web3.utils.toBN(200));
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

        assert.equal(await web3.eth.getBalance(pReserve.address), web3.utils.toBN(400));
        assert.equal((await escrow.escrowState()).toNumber(), EscrowState.CLOSED);
    });

    it("Test postPuzzle after expiry, refundPuzzle works", async () => {
        var escrow = await setupEthEscrow(1000, getCurrentTimeUnixEpoch());
        
        var preimage = web3.utils.keccak256("test preimage");
        var puzzle = web3.utils.keccak256(preimage);
        var puzzleTimelock = getCurrentTimeUnixEpoch(); // set puzzle timelock to now

       var { eSig, pSig } = signPuzzle(escrow.address, 600, 200, 200, puzzle, puzzleTimelock);
        
        var txResult = await escrow.postPuzzle(600, 200, 200, puzzle, puzzleTimelock, eSig.v, eSig.r, eSig.s, pSig.v, pSig.r, pSig.s);
        PrintGasUsage("postPuzzle", txResult.receipt);
        totalGasUsed += txResult.receipt.gasUsed;

        // State assertions after puzzle has been posted
        assert.equal(await web3.eth.getBalance(eReserve.address), web3.utils.toBN(600));
        assert.equal(await web3.eth.getBalance(pReserve.address), web3.utils.toBN(200));
        assert.equal((await escrow.escrowState()).toNumber(), EscrowState.PUZZLE_POSTED);

        // Refunding the puzzle should succeed and release the tradeAmount back to the escrower 
        var txResult = await escrow.refundPuzzle();
        PrintGasUsage("refundPuzzle", txResult.receipt);
        totalGasUsed += txResult.receipt.gasUsed;

        assert.equal(await web3.eth.getBalance(eReserve.address), web3.utils.toBN(800));
        assert.equal((await escrow.escrowState()).toNumber(), EscrowState.CLOSED);
    });
});

contract('Erc20Escrow', async (accounts) => {
    var mainAccount = web3.utils.toChecksumAddress(accounts[0]);
    var totalGasUsed = 0;
    var testToken: TestTokenInstance;

    beforeEach(async () => {
        // generate fresh accounts to use for every test
        generateNewAccounts();
        totalGasUsed = 0;

        // Create a test erc20 token with an initial balance minted to the mainAccount
        testToken = await TestToken.new({from: mainAccount});
    });

    afterEach(() => {
        console.log("total gas used: " + totalGasUsed);
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
            [ eReserve.address, eTrade.address, eRefund.address ],
            [ pReserve.address, pTrade.address ],
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
        return escrow;
    }

    it("Test cashout escrow", async () => {
        var erc20Escrow = await setupERC20Escrow(1000, getCurrentTimeUnixEpoch());
        var { eSig, pSig } = signCashout(erc20Escrow.address, 600, 400);
        var txResult = await erc20Escrow.cashout(600, 400, eSig.v, eSig.r, eSig.s, pSig.v, pSig.r, pSig.s);
        PrintGasUsage("cashout", txResult.receipt);
        totalGasUsed += txResult.receipt.gasUsed;

        assert.equal((await testToken.balanceOf(eReserve.address)).toNumber(), 600);
        assert.equal((await testToken.balanceOf(pReserve.address)).toNumber(), 400);
        assert.equal((await erc20Escrow.escrowState()).toNumber(), EscrowState.CLOSED);
    });

    it("Test refund escrow before expiry", async () => {
        var escrowNotExpired = await setupERC20Escrow(1000, getCurrentTimeUnixEpoch() + 24 * 60 * 60 );
        var eSig = signEscrowRefund(escrowNotExpired.address, 600, 400);
        try {
            await escrowNotExpired.refund(600, 400, eSig.v, eSig.r, eSig.s);
            fail("Refunding escrow before it has expired should fail");
        } catch(err) {
            assert.match(err, new RegExp("Timelock not reached"));
        }
    });

    it("Test refund expired escrow", async () => {
        var expiredEscrow = await setupERC20Escrow(1000, getCurrentTimeUnixEpoch());
        var eSig = signEscrowRefund(expiredEscrow.address, 600, 400);
        var txResult = await expiredEscrow.refund(600, 400, eSig.v, eSig.r, eSig.s);
        PrintGasUsage("refund", txResult.receipt);
        totalGasUsed += txResult.receipt.gasUsed;

        assert.isTrue(new BigNumber(600).isEqualTo(await testToken.balanceOf(eReserve.address)));
        assert.isTrue(new BigNumber(400).isEqualTo(await testToken.balanceOf(pReserve.address)));
        assert.equal((await expiredEscrow.escrowState()).toNumber(), EscrowState.CLOSED);
    });

    it("Test postPuzzle before expiry, refundPuzzle fails, solvePuzzle works", async () => {
        var escrow = await setupERC20Escrow(1000, getCurrentTimeUnixEpoch());
        
        var preimage = web3.utils.keccak256("test preimage");
        var puzzle = web3.utils.keccak256(preimage);
        var puzzleTimelock = getCurrentTimeUnixEpoch() + 24 * 60 * 60 ; // set puzzle timelock 1 day from now
        var { eSig, pSig } = signPuzzle(escrow.address, 600, 200, 200, puzzle, puzzleTimelock);

        var txResult = await escrow.postPuzzle(600, 200, 200, puzzle, puzzleTimelock, eSig.v, eSig.r, eSig.s, pSig.v, pSig.r, pSig.s);
        PrintGasUsage("postPuzzle", txResult.receipt);
        totalGasUsed += txResult.receipt.gasUsed;

        // State assertions after puzzle has been posted
        assert.isTrue(new BigNumber(600).isEqualTo(await testToken.balanceOf(eReserve.address)));
        assert.isTrue(new BigNumber(200).isEqualTo(await testToken.balanceOf(pReserve.address)));
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

        assert.isTrue(new BigNumber(400).isEqualTo(await testToken.balanceOf(pReserve.address)));
        assert.equal((await escrow.escrowState()).toNumber(), EscrowState.CLOSED);
    });

    it("Test postPuzzle after expiry, refundPuzzle works", async () => {
        var escrow = await setupERC20Escrow(1000, getCurrentTimeUnixEpoch());
        
        var preimage = web3.utils.keccak256("test preimage");
        var puzzle = web3.utils.keccak256(preimage);
        var puzzleTimelock = getCurrentTimeUnixEpoch(); // set puzzle timelock to now

       var { eSig, pSig } = signPuzzle(escrow.address, 600, 200, 200, puzzle, puzzleTimelock);
        
        var txResult = await escrow.postPuzzle(600, 200, 200, puzzle, puzzleTimelock, eSig.v, eSig.r, eSig.s, pSig.v, pSig.r, pSig.s);
        PrintGasUsage("postPuzzle", txResult.receipt);
        totalGasUsed += txResult.receipt.gasUsed;

        // State assertions after puzzle has been posted
        assert.isTrue(new BigNumber(600).isEqualTo(await testToken.balanceOf(eReserve.address)));
        assert.isTrue(new BigNumber(200).isEqualTo(await testToken.balanceOf(pReserve.address)));
        assert.equal((await escrow.escrowState()).toNumber(), EscrowState.PUZZLE_POSTED);

        // Refunding the puzzle should succeed and release the tradeAmount back to the escrower 
        var txResult = await escrow.refundPuzzle();
        PrintGasUsage("refundPuzzle", txResult.receipt);
        totalGasUsed += txResult.receipt.gasUsed;

        assert.isTrue(new BigNumber(800).isEqualTo(await testToken.balanceOf(eReserve.address)));
        assert.equal((await escrow.escrowState()).toNumber(), EscrowState.CLOSED);
    });
});