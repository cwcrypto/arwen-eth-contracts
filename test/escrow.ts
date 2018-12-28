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

/* Globals */
var eReserve: Account, eTrade: Account, eRefund: Account;
var pReserve: Account, pTrade: Account, pPuzzle: Account;

/* Helpers */

function getCurrentTimeUnixEpoch() {
    return Math.floor(new Date().valueOf() / 1000)
}

function generateNewAccounts() {
    eReserve = web3.eth.accounts.create();
    eTrade = web3.eth.accounts.create();
    eRefund = web3.eth.accounts.create();
    pReserve = web3.eth.accounts.create();
    pTrade = web3.eth.accounts.create();
    pPuzzle = web3.eth.accounts.create();
}

interface DuoSigned { eSig: MessageSignature, pSig: MessageSignature };

function signCashout(addr: string, escrowAmt: number, payeeAmt: number): DuoSigned {
    var types = ['address', 'uint256', 'uint256'];
    var values = [addr, escrowAmt, payeeAmt];
    var digest = web3.eth.abi.encodeParameters(types, values);
    var h = web3.utils.keccak256(digest);
    return {
        eSig: eTrade.sign(h),
        pSig: pTrade.sign(h)
    };
}

function signEscrowRefund(addr: string, escrowAmt: number, payeeAmt: number): MessageSignature {
    var types = ['address', 'uint256', 'uint256'];
    var values = [addr, escrowAmt, payeeAmt];
    var digest = web3.eth.abi.encodeParameters(types, values);
    var h = web3.utils.keccak256(digest);
    return eRefund.sign(h);
}

function signPuzzle(addr: string, escrowAmt: number, payeeAmt: number, tradeAmt: number, puzzle: string, timelock: number): DuoSigned {
    var types = ['address', 'uint256', 'uint256', 'uint256', 'bytes32', 'uint256'];
    var values = [addr, escrowAmt, payeeAmt, tradeAmt, puzzle, timelock];
    var digest = web3.eth.abi.encodeParameters(types, values);
    var h = web3.utils.keccak256(digest);
    return {
        eSig: eTrade.sign(h),
        pSig: pTrade.sign(h)
    };
}

/**
 * Escrow state enum matching the Escrow.sol internal state machine
 */
enum EscrowState { UNFUNDED, OPEN, PUZZLE_POSTED, CLOSED }

contract('EthEscrow', async (accounts) => {
    var mainAccount = web3.utils.toChecksumAddress(accounts[0]);

    beforeEach(async () => {
        // generate fresh accounts to use for every test
        generateNewAccounts();
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
            [ pReserve.address, pTrade.address, pPuzzle.address ], 
            escrowTimelock,
            { from: mainAccount, value: escrowAmount}
        );
        assert.equal((await escrow.escrowAmount()).toNumber(), escrowAmount, "escrow amount");
        return escrow;
    }

    it("Test verify signature", async () => {
        var escrow = await setupEthEscrow(1000, getCurrentTimeUnixEpoch());
        var h = web3.utils.keccak256("test message");
        var eSig = await eTrade.sign(h);
        var addr = await escrow.verify(h, eSig.v, eSig.r, eSig.s);
        assert.equal(addr, eTrade.address, "verify address");
    });

    it("Test cashout escrow", async () => {
        var ethEscrow = await setupEthEscrow(1000, getCurrentTimeUnixEpoch());
        var { eSig, pSig } = signCashout(ethEscrow.address, 600, 400);
        var txResult = await ethEscrow.cashout(600, 400, eSig.v, eSig.r, eSig.s, pSig.v, pSig.r, pSig.s);
        console.log("gas used for cashout tx: " + txResult.receipt.gasUsed);

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
        console.log("gas used for refund tx: " + txResult.receipt.gasUsed);

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
        console.log("gas used for postPuzzle tx: " + txResult.receipt.gasUsed);

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
        console.log("gas used for solvePuzzle tx: " + txResult.receipt.gasUsed);

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
        console.log("gas used for postPuzzle tx: " + txResult.receipt.gasUsed);

        // State assertions after puzzle has been posted
        assert.equal(await web3.eth.getBalance(eReserve.address), web3.utils.toBN(600));
        assert.equal(await web3.eth.getBalance(pReserve.address), web3.utils.toBN(200));
        assert.equal((await escrow.escrowState()).toNumber(), EscrowState.PUZZLE_POSTED);

        // Refunding the puzzle should succeed and release the tradeAmount back to the escrower 
        var txResult = await escrow.refundPuzzle();
        console.log("gas used for refundPuzzle tx: " + txResult.receipt.gasUsed);

        assert.equal(await web3.eth.getBalance(eReserve.address), web3.utils.toBN(800));
        assert.equal((await escrow.escrowState()).toNumber(), EscrowState.CLOSED);
    });
});

contract('Erc20Escrow', async (accounts) => {
    var mainAccount = web3.utils.toChecksumAddress(accounts[0]);
    var testToken: TestTokenInstance;

    beforeEach(async () => {
        // generate fresh accounts to use for every test
        generateNewAccounts();

        // Create a test erc20 token with an initial balance minted to the mainAccount
        testToken = await TestToken.new({from: mainAccount});
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
            [ pReserve.address, pTrade.address, pPuzzle.address ], 
            escrowTimelock,
            { from: mainAccount }
        );
        
        // Approve escrow contract to transfer the tokens on behalf of mainAccount
        testToken.approve(escrow.address, escrowAmount, {from: mainAccount});
        escrow.fundEscrow(mainAccount);
        assert.equal((await escrow.escrowAmount()).toNumber(), escrowAmount, "escrow amount");
        return escrow;
    }

    it("Test cashout escrow", async () => {
        var erc20Escrow = await setupERC20Escrow(1000, getCurrentTimeUnixEpoch());
        var { eSig, pSig } = signCashout(erc20Escrow.address, 600, 400);
        var txResult = await erc20Escrow.cashout(600, 400, eSig.v, eSig.r, eSig.s, pSig.v, pSig.r, pSig.s);
        console.log("gas used for cashout tx: " + txResult.receipt.gasUsed);

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
        console.log("gas used for refund tx: " + txResult.receipt.gasUsed);

        assert.equal((await testToken.balanceOf(eReserve.address)).toNumber(), 600);
        assert.equal((await testToken.balanceOf(pReserve.address)).toNumber(), 400);
        assert.equal((await expiredEscrow.escrowState()).toNumber(), EscrowState.CLOSED);
    });

    it("Test postPuzzle before expiry, refundPuzzle fails, solvePuzzle works", async () => {
        var escrow = await setupERC20Escrow(1000, getCurrentTimeUnixEpoch());
        
        var preimage = web3.utils.keccak256("test preimage");
        var puzzle = web3.utils.keccak256(preimage);
        var puzzleTimelock = getCurrentTimeUnixEpoch() + 24 * 60 * 60 ; // set puzzle timelock 1 day from now
        var { eSig, pSig } = signPuzzle(escrow.address, 600, 200, 200, puzzle, puzzleTimelock);

        var txResult = await escrow.postPuzzle(600, 200, 200, puzzle, puzzleTimelock, eSig.v, eSig.r, eSig.s, pSig.v, pSig.r, pSig.s);
        console.log("gas used for postPuzzle tx: " + txResult.receipt.gasUsed);

        // State assertions after puzzle has been posted
        assert.equal((await testToken.balanceOf(eReserve.address)).toNumber(), 600);
        assert.equal((await testToken.balanceOf(pReserve.address)).toNumber(), 200);
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
        console.log("gas used for solvePuzzle tx: " + txResult.receipt.gasUsed);

        assert.equal((await testToken.balanceOf(pReserve.address)).toNumber(),400);
        assert.equal((await escrow.escrowState()).toNumber(), EscrowState.CLOSED);
    });

    it("Test postPuzzle after expiry, refundPuzzle works", async () => {
        var escrow = await setupERC20Escrow(1000, getCurrentTimeUnixEpoch());
        
        var preimage = web3.utils.keccak256("test preimage");
        var puzzle = web3.utils.keccak256(preimage);
        var puzzleTimelock = getCurrentTimeUnixEpoch(); // set puzzle timelock to now

       var { eSig, pSig } = signPuzzle(escrow.address, 600, 200, 200, puzzle, puzzleTimelock);
        
        var txResult = await escrow.postPuzzle(600, 200, 200, puzzle, puzzleTimelock, eSig.v, eSig.r, eSig.s, pSig.v, pSig.r, pSig.s);
        console.log("gas used for postPuzzle tx: " + txResult.receipt.gasUsed);

        // State assertions after puzzle has been posted
        assert.equal((await testToken.balanceOf(eReserve.address)).toNumber(), 600);
        assert.equal((await testToken.balanceOf(pReserve.address)).toNumber(),200);
        assert.equal((await escrow.escrowState()).toNumber(), EscrowState.PUZZLE_POSTED);

        // Refunding the puzzle should succeed and release the tradeAmount back to the escrower 
        var txResult = await escrow.refundPuzzle();
        console.log("gas used for refundPuzzle tx: " + txResult.receipt.gasUsed);

        assert.equal((await testToken.balanceOf(eReserve.address)).toNumber(), 800);
        assert.equal((await escrow.escrowState()).toNumber(), EscrowState.CLOSED);
    });
});