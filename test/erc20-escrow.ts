// Setup web3 provider to point at local development blockchain spawned by truffle develop
import Web3 from 'web3';
const web3 = new Web3('http://localhost:9545');

// Import truffle contract abstractions
const EscrowFactory = artifacts.require("EscrowFactory");
const EscrowLibrary = artifacts.require("EscrowLibrary");
const Erc20Escrow = artifacts.require("Erc20Escrow");
const TestToken = artifacts.require("TestToken");

import { EscrowFactoryInstance, EscrowLibraryInstance, Erc20EscrowInstance, TestTokenInstance } from './../types/truffle-contracts';
import { fail } from 'assert';
import { BigNumber } from "bignumber.js";
import { TestSigningService, GasMeter, getCurrentTimeUnixEpoch, EscrowState, EscrowParams, hashPreimage} from './common';

contract('Erc20Escrow', async (accounts) => {
    var mainAccount = web3.utils.toChecksumAddress(accounts[0]);
    var testToken: TestTokenInstance;
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
        // Create a test erc20 token with an initial balance minted to the mainAccount
        testToken = await TestToken.new({from: mainAccount});
    });

    afterEach(() => {
       gasMeter.printAggregateGasUsage(false);
    });

    /** 
     * Helper method that creates a new Erc20Escrow contract instance.
     * Automatically uses the escrower/payee keys generated for the current
     * test. Funds the Erc20Escrow after it is created.
     * @param escrowAmount The amount to send to this escrow
     * @param escrowTimelcok The refund timelock of this escrow
     */
    async function setupERC20Escrow(escrowAmount: number, escrowTimelock: number) : Promise<Erc20EscrowInstance> {
        var escrow = await deployERC20EscrowFromFactory(testToken.address, escrowAmount, escrowTimelock);

        // Approve escrow contract to transfer the tokens on behalf of mainAccount
        var txResult = await testToken.transfer(escrow.address, escrowAmount, {from: mainAccount});
        gasMeter.TrackGasUsage("ERC20 token approve", txResult.receipt);

        txResult = await escrowLibrary.openEscrow(escrow.address);
        gasMeter.TrackGasUsage("fundEscrow", txResult.receipt);

        return escrow;
    }

    async function getEscrowParams(escrowAddress: string): Promise<EscrowParams> {
        return (await escrowLibrary.escrows(escrowAddress)) as any;
    }

    async function deployERC20EscrowFromFactory(tknAddr: string, escrowAmount: number, escrowTimelock: number) : Promise<Erc20EscrowInstance> {
        var txResult = await escrowFactory.createErc20Escrow(
            tknAddr,
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
        return await Erc20Escrow.at(escrowCreatedEvent.args.escrowAddress);
    }

    it("Test construct Erc20 Escrow", async () => {
        var escrowAmount = 1000;
        var escrowTimelock = getCurrentTimeUnixEpoch();
        var escrow = await setupERC20Escrow(escrowAmount, escrowTimelock);
        
        var escrowParams = await getEscrowParams(escrow.address);
        assert.equal(escrowParams.escrowAmount.toNumber(), escrowAmount);
        assert.equal(escrowParams.escrowTimelock.toNumber(), escrowTimelock);
        assert.equal(escrowParams.escrowRefund, TSS.eRefund.address);
        assert.equal(escrowParams.escrowTrade, TSS.eTrade.address);
        assert.equal(escrowParams.payeeTrade, TSS.pTrade.address);
        assert.equal(escrowParams.escrowReserve, TSS.eReserve.address);
        assert.equal(escrowParams.payeeReserve, TSS.pReserve.address);
        assert.equal(escrowParams.escrowState.toNumber(), EscrowState.Open);

        assert.equal((await testToken.balanceOf(escrow.address)).toString(), escrowAmount.toString());
    });

    it("Test cashout escrow", async () => {
        var escrow = await setupERC20Escrow(1000, getCurrentTimeUnixEpoch());
        var { eSig, pSig } = TSS.signCashout(escrow.address, 400);
        var txResult = await escrowLibrary.cashout(escrow.address, 400, eSig.signature, pSig.signature);
        gasMeter.TrackGasUsage("cashout", txResult.receipt);

        assert.isTrue(new BigNumber(600).isEqualTo(await testToken.balanceOf(TSS.eReserve.address)), "final escrower reserve balance");
        assert.isTrue(new BigNumber(400).isEqualTo(await testToken.balanceOf(TSS.pReserve.address)), "final payee reserve balance");
    });

    it("Test refund escrow before expiry", async () => {
        var escrow = await setupERC20Escrow(1000, getCurrentTimeUnixEpoch() + 24 * 60 * 60 );
        var eSig = TSS.signEscrowRefund(escrow.address, 400);
        try {
            await escrowLibrary.refund(escrow.address, 400, eSig.signature);
            fail("Refunding escrow before it has expired should fail");
        } catch(err) {
            assert.match(err, new RegExp("Escrow timelock not reached"));
        }
    });

    it("Test refund expired escrow", async () => {
        var escrow = await setupERC20Escrow(1000, getCurrentTimeUnixEpoch());
        var eSig = TSS.signEscrowRefund(escrow.address, 400);
        var txResult = await escrowLibrary.refund(escrow.address, 400, eSig.signature);
        gasMeter.TrackGasUsage("refund", txResult.receipt);

        assert.isTrue(new BigNumber(600).isEqualTo(await testToken.balanceOf(TSS.eReserve.address)), "final escrower reserve balance");
        assert.isTrue(new BigNumber(400).isEqualTo(await testToken.balanceOf(TSS.pReserve.address)), "final payee reserve balance");
    });

    it("Test postPuzzle before expiry, refundPuzzle fails, solvePuzzle works", async () => {
        var escrow = await setupERC20Escrow(1000, getCurrentTimeUnixEpoch());
        
        var preimage = web3.utils.keccak256("test preimage");
        var puzzle = hashPreimage(preimage);
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
        
        assert.isTrue(new BigNumber(600).isEqualTo(await testToken.balanceOf(TSS.eReserve.address)), "final escrower reserve balance");
        assert.isTrue(new BigNumber(400).isEqualTo(await testToken.balanceOf(TSS.pReserve.address)), "final payee reserve balance");
    });

    it("Test postPuzzle after expiry, refundPuzzle works", async () => {
        var escrow = await setupERC20Escrow(1000, getCurrentTimeUnixEpoch());
        
        var preimage = web3.utils.keccak256("test preimage");
        var puzzle = hashPreimage(preimage);
        var puzzleTimelock = getCurrentTimeUnixEpoch(); // set puzzle timelock to now

       var { eSig, pSig } = TSS.signPuzzle(escrow.address, 200, 200, puzzle, puzzleTimelock);
        
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

        assert.isTrue(new BigNumber(800).isEqualTo(await testToken.balanceOf(TSS.eReserve.address)), "final escrower reserve balance");
        assert.isTrue(new BigNumber(200).isEqualTo(await testToken.balanceOf(TSS.pReserve.address)), "final payee reserve balance");
    });
});