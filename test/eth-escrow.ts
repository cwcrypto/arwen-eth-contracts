// Setup web3 provider to point at local development blockchain spawned by truffle develop
import Web3 from 'web3';
const web3 = new Web3('http://localhost:9545');

// Import truffle contract abstractions
const EscrowFactory = artifacts.require("EscrowFactory");
const EscrowLibrary = artifacts.require("EscrowLibrary");
const EthEscrow = artifacts.require("EthEscrow");

import { EscrowFactoryInstance, EscrowLibraryInstance, EthEscrowInstance } from '../types/truffle-contracts';
import { fail } from 'assert';
import { BigNumber } from "bignumber.js";
import { TestSigningService, GasMeter, getCurrentTimeUnixEpoch, EscrowState, EscrowParams } from './common';

contract('EthEscrow', async (accounts) => {
    var mainAccount = web3.utils.toChecksumAddress(accounts[0]);
    var TSS: TestSigningService;
    var gasMeter: GasMeter;

    var escrowFactory: EscrowFactoryInstance;
    var escrowLibrary: EscrowLibraryInstance;

    before(async () => {
        escrowFactory = await EscrowFactory.deployed();
        escrowLibrary = await EscrowLibrary.at(await escrowFactory.escrowLibrary());
    });

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
        var escrow = await deployEthEscrowFromFactory(escrowAmount, escrowTimelock);
        
        // Fund Escrow by sending directly to the contract using the fallback
        // function. This requires a cast to any until truffle-typings adds
        // sendTransaction to its type definitions
        var fundTxReceipt = await (escrow as any).sendTransaction({
            from: mainAccount, 
            value: escrowAmount,
        });
        gasMeter.TrackGasUsage("EthEscrow fallback funding", fundTxReceipt.receipt);
        
        // Open
        var openTx = await escrowLibrary.openEscrow(escrow.address);
        gasMeter.TrackGasUsage("EthEscrow openEscrow", openTx.receipt);
        
        return escrow;
    }

    async function getEscrowParams(escrowAddress: string): Promise<EscrowParams> {
        return await escrowLibrary.escrows(escrowAddress) as any;
        // var [escrowAmount, escrowTimelock, escrowRefund, escrowTrade, payeeTrade] = await escrowLibrary.escrows(escrowAddress);
        // return {
        //     escrowAmount: escrowAmount,
        //     escrowTimelock: escrowTimelock,
        //     escrowRefund: escrowRefund,
        //     escrowTrade: escrowTrade,
        //     payeeTrade: payeeTrade
        // }
    }

    async function deployEthEscrowFromFactory(escrowAmount: number, escrowTimelock: number) : Promise<EthEscrowInstance> {
        var txResult = await escrowFactory.createEthEscrow(
            escrowAmount,
            escrowTimelock,
            TSS.eReserve.address,
            TSS.eTrade.address,
            TSS.eRefund.address,
            TSS.pReserve.address,
            TSS.pTrade.address,
            { from: mainAccount }
        );
        gasMeter.TrackGasUsage("Factory createEthEscrow", txResult.receipt);

        // Extract escrow contract address from logs
        var logs = txResult.logs;
        assert.equal(logs.length, 1);
        var escrowCreatedEvent = logs[0];
        assert.equal(escrowCreatedEvent.event, "EscrowCreated");

        // Create a EthEscrow contract instance at the new escrow address
        return await EthEscrow.at(escrowCreatedEvent.args.escrowAddress);
    }

    it("Test construct Eth Escrow", async () => {
        var escrowAmount = 1000;
        var escrowTimelock = getCurrentTimeUnixEpoch();
        var escrow = await setupEthEscrow(escrowAmount, escrowTimelock);
        
        var escrowParams = await getEscrowParams(escrow.address);
        assert.equal(escrowParams.escrowAmount.toNumber(), escrowAmount, "escrow amount");
        assert.equal(escrowParams.escrowTimelock.toNumber(), escrowTimelock, "escrow timelock");
        assert.equal(escrowParams.escrowRefund, TSS.eRefund.address, "escrower refund address");
        assert.equal(escrowParams.escrowTrade, TSS.eTrade.address, "escrower trade address");
        assert.equal(escrowParams.payeeTrade, TSS.pTrade.address, "payee trade address");
        assert.equal(escrowParams.escrowReserve, TSS.eReserve.address, "escrower reserve address");
        assert.equal(escrowParams.payeeReserve, TSS.pReserve.address, "payee reserve address");
        assert.equal(escrowParams.escrowState.toNumber(), EscrowState.Open, "escrow state");
        assert.equal(escrowParams.escrowerBalance.toString(), "0", "starting escrower balance");
        assert.equal(escrowParams.payeeBalance.toString(), "0", "starting payee balance");

        assert.equal(await web3.eth.getBalance(escrow.address), escrowAmount.toString());
    });

    it("Test cashout escrow", async () => {
        var escrow = await setupEthEscrow(1000, getCurrentTimeUnixEpoch());
        var { eSig, pSig } = TSS.signCashout(escrow.address, 400);
        var txResult = await escrowLibrary.cashout(escrow.address, 400, eSig.signature, pSig.signature);
        gasMeter.TrackGasUsage("cashout", txResult.receipt);

        assert.equal(await web3.eth.getBalance(TSS.eReserve.address), "600", "final escrower reserve balance");
        assert.equal(await web3.eth.getBalance(TSS.pReserve.address), "400", "final payee reserve balance");
    });

    it("Test refund escrow before expiry", async () => {
        var escrow = await setupEthEscrow(1000, getCurrentTimeUnixEpoch() + 24 * 60 * 60 );
        var eSig = TSS.signEscrowRefund(escrow.address, 400);
        try {
            await escrowLibrary.refund(escrow.address, 400, eSig.signature);
            fail("Refunding escrow before it has expired should fail");
        } catch(err) {
            assert.match(err, new RegExp("Escrow timelock not reached"));
        }
    });

    it("Test refund expired escrow", async () => {
        var escrow = await setupEthEscrow(1000, getCurrentTimeUnixEpoch());
        var eSig = TSS.signEscrowRefund(escrow.address, 400);
        var txResult = await escrowLibrary.refund(escrow.address, 400, eSig.signature);
        gasMeter.TrackGasUsage("refund", txResult.receipt);

        assert.equal(await web3.eth.getBalance(TSS.eReserve.address), "600", "final escrower reserve balance");
        assert.equal(await web3.eth.getBalance(TSS.pReserve.address), "400", "final payee reserve balance");
    });

    it("Test postPuzzle before expiry, refundPuzzle fails, solvePuzzle works", async () => {
        var escrow = await setupEthEscrow(1000, getCurrentTimeUnixEpoch());
        
        var preimage = web3.utils.keccak256("test preimage");
        var puzzle = web3.utils.keccak256(preimage);
        var puzzleTimelock = getCurrentTimeUnixEpoch() + 24 * 60 * 60 ; // set puzzle timelock 1 day from now
        var { eSig, pSig } = TSS.signPuzzle(escrow.address, 200, 200, puzzle, puzzleTimelock);

        var txResult = await escrowLibrary.postPuzzle(escrow.address, 200, 200, puzzle, puzzleTimelock, 
            eSig.signature,
            pSig.signature
        );
        gasMeter.TrackGasUsage("postPuzzle", txResult.receipt);

        // State assertions after puzzle has been posted
        var escrowParams = await getEscrowParams(escrow.address);
        assert.equal(escrowParams.escrowState.toNumber(), EscrowState.PuzzlePosted);

        // Refunding the puzzle should fail because we have not yet hit the timelock
        try {
            await escrowLibrary.refundPuzzle(escrow.address);
            fail("Refunding puzzle before it has expired should fail");
        } catch(err) {
            assert.match(err, new RegExp("Puzzle timelock not reached"));
        }

        // Solving the puzzle with the correct preimage should succeed and release the tradeAmount to the payee 
        var txResult = await escrowLibrary.solvePuzzle(escrow.address, preimage);
        gasMeter.TrackGasUsage("solvePuzzle", txResult.receipt);
        
        assert.equal(await web3.eth.getBalance(TSS.eReserve.address), "600", "final escrower reserve balance");
        assert.equal(await web3.eth.getBalance(TSS.pReserve.address), "400", "final payee reserve balance");
    });

    it("Test postPuzzle after expiry, refundPuzzle works", async () => {
        var escrow = await setupEthEscrow(1000, getCurrentTimeUnixEpoch());
        
        var preimage = web3.utils.keccak256("test preimage");
        var puzzle = web3.utils.keccak256(preimage);
        var puzzleTimelock = getCurrentTimeUnixEpoch(); // set puzzle timelock to now

        var {eSig, pSig} = TSS.signPuzzle(escrow.address, 200, 200, puzzle, puzzleTimelock);


        var txResult = await escrowLibrary.postPuzzle(escrow.address, 200, 200, puzzle, puzzleTimelock, 
            eSig.signature,
            pSig.signature
        );
        gasMeter.TrackGasUsage("postPuzzle", txResult.receipt);

        // State assertions after puzzle has been posted
        var escrowParams = await getEscrowParams(escrow.address);
        assert.equal(escrowParams.escrowState.toNumber(), EscrowState.PuzzlePosted);

        // Refunding the puzzle should succeed and release the tradeAmount back to the escrower 
        var txResult = await escrowLibrary.refundPuzzle(escrow.address);
        gasMeter.TrackGasUsage("refundPuzzle", txResult.receipt);

        assert.equal(await web3.eth.getBalance(TSS.eReserve.address), "800", "final escrower reserve balance");
        assert.equal(await web3.eth.getBalance(TSS.pReserve.address), "200", "final payee reserve balance");
    });
});