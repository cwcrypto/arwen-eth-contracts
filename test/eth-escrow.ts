// Setup web3 provider to point at local development blockchain spawned by truffle develop
import Web3 from 'web3';
const web3 = new Web3('http://localhost:9545');

// Import truffle contract abstractions
const EthEscrow = artifacts.require("EthEscrow");

import { EthEscrowInstance } from '../types/truffle-contracts';
import { fail } from 'assert';
import { BigNumber } from "bignumber.js";
import { TestSigningService, GasMeter, getCurrentTimeUnixEpoch, EscrowState } from './common';

contract('EthEscrow', async (accounts) => {
    var mainAccount = web3.utils.toChecksumAddress(accounts[0]);
    var TSS: TestSigningService;
    var gasMeter: GasMeter;

    beforeEach(async () => {
        // generate fresh accounts to use for every test
        TSS = new TestSigningService();
        gasMeter = new GasMeter();
    });

    afterEach(() => {
        gasMeter.printAggregateGasUsage(false);
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
            TSS.eReserve.address, TSS.eTrade.address, TSS.eRefund.address,
            TSS.pReserve.address, TSS.pTrade.address,
            escrowTimelock,
            { from: mainAccount, value: escrowAmount}
        );
        var receipt = await web3.eth.getTransactionReceipt(escrow.transactionHash);
        gasMeter.TrackGasUsage("EthEscrow constructor", receipt);

        assert.isTrue(new BigNumber(escrowAmount).isEqualTo(await escrow.escrowAmount()), "escrow amount");
        return escrow;
    }

    /**
     * Attempts to withdraw any available balances for the escrower or payee in
     * the escrow and records the gas used by calling the withdraw methods
     */
    async function withdrawBalances(escrow: EthEscrowInstance) {
        let escrowerBalance = await escrow.escrowerBalance();
        let payeeBalance = await escrow.payeeBalance();
        if( escrowerBalance.toNumber() > 0 || payeeBalance.toNumber() > 0) {
            let txResult = await escrow.withdrawFunds();
            gasMeter.TrackGasUsage("Withdraw Escrower+Payee Balance", txResult.receipt);
        }
    }

    it("Test construct Eth Escrow", async () => {
        var escrowAmount = 1000;
        var escrowTimelock = getCurrentTimeUnixEpoch();
        var escrow = await setupEthEscrow(escrowAmount, escrowTimelock);

        assert.equal(await web3.eth.getBalance(escrow.address), escrowAmount.toString());
        assert.equal((await escrow.escrowTimelock()).toNumber(), escrowTimelock);
        assert.equal((await escrow.escrowerBalance()).toString(), "0");
        assert.equal((await escrow.payeeBalance()).toString(), "0");
        assert.equal((await escrow.escrowState()).toNumber(), EscrowState.OPEN);
    });

    it("Test cashout escrow", async () => {
        var escrow = await setupEthEscrow(1000, getCurrentTimeUnixEpoch());
        var { eSig, pSig } = TSS.signCashout(escrow.address, 400);
        var txResult = await escrow.cashout(400, eSig.signature, pSig.signature);
        gasMeter.TrackGasUsage("cashout", txResult.receipt);

        await withdrawBalances(escrow);
        assert.equal(await web3.eth.getBalance(TSS.eReserve.address), "600");
        assert.equal(await web3.eth.getBalance(TSS.pReserve.address), "400");
        assert.equal((await escrow.escrowState()).toNumber(), EscrowState.CLOSED);
    });

    it("Test refund escrow before expiry", async () => {
        var escrowNotExpired = await setupEthEscrow(1000, getCurrentTimeUnixEpoch() + 24 * 60 * 60 );
        var eSig = TSS.signEscrowRefund(escrowNotExpired.address, 400);
        try {
            await escrowNotExpired.refund(400, eSig.signature);
            fail("Refunding escrow before it has expired should fail");
        } catch(err) {
            assert.match(err, new RegExp("Timelock not reached"));
        }
    });

    it("Test refund expired escrow", async () => {
        var expiredEscrow = await setupEthEscrow(1000, getCurrentTimeUnixEpoch());
        var eSig = TSS.signEscrowRefund(expiredEscrow.address, 400);
        var txResult = await expiredEscrow.refund(400, eSig.signature);
        gasMeter.TrackGasUsage("refund", txResult.receipt);

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

        var txResult = await escrow.postPuzzle(200, 200, puzzle, puzzleTimelock, 
            eSig.signature,
            pSig.signature
            );
        gasMeter.TrackGasUsage("postPuzzle", txResult.receipt);

        // State assertions after puzzle has been posted
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
        gasMeter.TrackGasUsage("solvePuzzle", txResult.receipt);

        await withdrawBalances(escrow);
        assert.equal(await web3.eth.getBalance(TSS.pReserve.address), "400");
        assert.equal((await escrow.escrowState()).toNumber(), EscrowState.CLOSED);
    });

    it("Test postPuzzle after expiry, refundPuzzle works", async () => {
        var escrow = await setupEthEscrow(1000, getCurrentTimeUnixEpoch());
        
        var preimage = web3.utils.keccak256("test preimage");
        var puzzle = web3.utils.keccak256(preimage);
        var puzzleTimelock = getCurrentTimeUnixEpoch(); // set puzzle timelock to now

        var {eSig, pSig} = TSS.signPuzzle(escrow.address, 200, 200, puzzle, puzzleTimelock);


        var txResult = await escrow.postPuzzle(200, 200, puzzle, puzzleTimelock, 
            eSig.signature,
            pSig.signature
            );

        gasMeter.TrackGasUsage("postPuzzle", txResult.receipt);

        // State assertions after puzzle has been posted
        assert.equal((await escrow.escrowState()).toNumber(), EscrowState.PUZZLE_POSTED);

        // Refunding the puzzle should succeed and release the tradeAmount back to the escrower 
        var txResult = await escrow.refundPuzzle();
        gasMeter.TrackGasUsage("refundPuzzle", txResult.receipt);

        await withdrawBalances(escrow);
        assert.equal(await web3.eth.getBalance(TSS.eReserve.address), "800");
        assert.equal((await escrow.escrowState()).toNumber(), EscrowState.CLOSED);
    });
});