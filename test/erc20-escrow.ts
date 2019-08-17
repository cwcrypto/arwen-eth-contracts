// Setup web3 provider to point at local development blockchain spawned by truffle develop
import Web3 from 'web3';
const web3 = new Web3('http://localhost:9545');

// Import truffle contract abstractions
const EscrowFactory = artifacts.require("EscrowFactory");
const Erc20Escrow = artifacts.require("Erc20Escrow");
const TestToken = artifacts.require("TestToken");

import { Erc20EscrowInstance, TestTokenInstance } from './../types/truffle-contracts';
import { fail } from 'assert';
import { BigNumber } from "bignumber.js";
import { TestSigningService, GasMeter, getCurrentTimeUnixEpoch, EscrowState } from './common';

contract('Erc20Escrow', async (accounts) => {
    var mainAccount = web3.utils.toChecksumAddress(accounts[0]);
    var testToken: TestTokenInstance;
    var TSS: TestSigningService;
    var gasMeter: GasMeter;

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
        // var escrow = await deployERC20Escrow(testToken.address, escrowAmount, escrowTimelock);
        var escrow = await deployERC20EscrowFromFactory(testToken.address, escrowAmount, escrowTimelock);

        // Approve escrow contract to transfer the tokens on behalf of mainAccount
        var txResult = await testToken.approve(escrow.address, escrowAmount, {from: mainAccount});
        gasMeter.TrackGasUsage("ERC20 token approve", txResult.receipt);

        txResult = await escrow.fundEscrow(mainAccount);
        gasMeter.TrackGasUsage("fundEscrow", txResult.receipt);

        assert.isTrue(new BigNumber(escrowAmount).isEqualTo(await escrow.escrowAmount()), "escrow amount");
        assert.equal((await escrow.escrowState()).toNumber(), EscrowState.Open);
        return escrow;
    }

    async function deployERC20Escrow(tknAddr: string, escrowAmount: number, escrowTimelock: number): Promise<Erc20EscrowInstance> {
        var escrow = await Erc20Escrow.new(
            tknAddr,
            escrowAmount,
            escrowTimelock,
            TSS.eReserve.address, TSS.eTrade.address, TSS.eRefund.address,
            TSS.pReserve.address, TSS.pTrade.address,
            { from: mainAccount }
        );

        let receipt = await web3.eth.getTransactionReceipt(escrow.transactionHash);
        gasMeter.TrackGasUsage("ERC20Escrow constructor", receipt);
        return escrow;
    }

    async function deployERC20EscrowFromFactory(tknAddr: string, escrowAmount: number, escrowTimelock: number) : Promise<Erc20EscrowInstance> {
        var escrowFactory = await EscrowFactory.deployed();
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

        assert.equal((await testToken.balanceOf(escrow.address)).toString(), escrowAmount.toString());
        assert.equal((await escrow.escrowTimelock()).toNumber(), escrowTimelock);
        assert.equal((await escrow.escrowState()).toNumber(), EscrowState.Open);
    });

    it("Test cashout escrow", async () => {
        var erc20Escrow = await setupERC20Escrow(1000, getCurrentTimeUnixEpoch());
        var { eSig, pSig } = TSS.signCashout(erc20Escrow.address, 400);
        var txResult = await erc20Escrow.cashout(400, eSig.signature, pSig.signature);
        gasMeter.TrackGasUsage("cashout", txResult.receipt);

        assert.isTrue(new BigNumber(600).isEqualTo(await testToken.balanceOf(TSS.eReserve.address)));
        assert.isTrue(new BigNumber(400).isEqualTo(await testToken.balanceOf(TSS.pReserve.address)));
    });

    it("Test refund escrow before expiry", async () => {
        var escrowNotExpired = await setupERC20Escrow(1000, getCurrentTimeUnixEpoch() + 24 * 60 * 60 );
        var eSig = TSS.signEscrowRefund(escrowNotExpired.address, 400);
        try {
            await escrowNotExpired.refund(400, eSig.signature);
            fail("Refunding escrow before it has expired should fail");
        } catch(err) {
            assert.match(err, new RegExp("Timelock not reached"));
        }
    });

    it("Test refund expired escrow", async () => {
        var expiredEscrow = await setupERC20Escrow(1000, getCurrentTimeUnixEpoch());
        var eSig = TSS.signEscrowRefund(expiredEscrow.address, 400);
        var txResult = await expiredEscrow.refund(400, eSig.signature);
        gasMeter.TrackGasUsage("refund", txResult.receipt);

        assert.isTrue(new BigNumber(600).isEqualTo(await testToken.balanceOf(TSS.eReserve.address)));
        assert.isTrue(new BigNumber(400).isEqualTo(await testToken.balanceOf(TSS.pReserve.address)));
    });

    it("Test postPuzzle before expiry, refundPuzzle fails, solvePuzzle works", async () => {
        var escrow = await setupERC20Escrow(1000, getCurrentTimeUnixEpoch());
        
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
        assert.isTrue(new BigNumber(600).isEqualTo(await testToken.balanceOf(TSS.eReserve.address)));
        assert.isTrue(new BigNumber(200).isEqualTo(await testToken.balanceOf(TSS.pReserve.address)));
        assert.equal((await escrow.escrowState()).toNumber(), EscrowState.PuzzlePosted);

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

        assert.isTrue(new BigNumber(400).isEqualTo(await testToken.balanceOf(TSS.pReserve.address)));
    });

    it("Test postPuzzle after expiry, refundPuzzle works", async () => {
        var escrow = await setupERC20Escrow(1000, getCurrentTimeUnixEpoch());
        
        var preimage = web3.utils.keccak256("test preimage");
        var puzzle = web3.utils.keccak256(preimage);
        var puzzleTimelock = getCurrentTimeUnixEpoch(); // set puzzle timelock to now

       var { eSig, pSig } = TSS.signPuzzle(escrow.address, 200, 200, puzzle, puzzleTimelock);
        
        var txResult = await escrow.postPuzzle(200, 200, puzzle, puzzleTimelock, 
            eSig.signature,
            pSig.signature
        );
        gasMeter.TrackGasUsage("postPuzzle", txResult.receipt);

        // State assertions after puzzle has been posted
        assert.isTrue(new BigNumber(600).isEqualTo(await testToken.balanceOf(TSS.eReserve.address)));
        assert.isTrue(new BigNumber(200).isEqualTo(await testToken.balanceOf(TSS.pReserve.address)));
        assert.equal((await escrow.escrowState()).toNumber(), EscrowState.PuzzlePosted);

        // Refunding the puzzle should succeed and release the tradeAmount back to the escrower 
        var txResult = await escrow.refundPuzzle();
        gasMeter.TrackGasUsage("refundPuzzle", txResult.receipt);

        assert.isTrue(new BigNumber(800).isEqualTo(await testToken.balanceOf(TSS.eReserve.address)));
    });
});