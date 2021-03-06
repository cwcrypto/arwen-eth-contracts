// Setup web3 provider to point at local development blockchain spawned by truffle develop
import Web3 from 'web3';
const web3 = new Web3('http://localhost:9545');

// Import truffle contract abstractions
const EscrowFactoryWithERC20 = artifacts.require("EscrowFactoryWithERC20");
const EscrowLibrary = artifacts.require("EscrowLibrary");
const Erc20Escrow = artifacts.require("Erc20Escrow");
const TestToken = artifacts.require("TestToken");

const Erc20EscrowBytecode = (Erc20Escrow as any).bytecode;

import { EscrowFactoryWithERC20Instance, EscrowLibraryInstance, Erc20EscrowInstance, TestTokenInstance } from './../types/truffle-contracts';
import { fail } from 'assert';
import { BigNumber } from "bignumber.js";
import { TestSigningService, GasMeter, getCurrentTimeUnixEpoch, EscrowState, hashPreimage, EscrowParams, FORCE_REFUND_TIMELOCK, GAS_LIMIT_FACTORY_DEPLOY, createNewEscrowParams, computeCreate2Address, getParamsHash } from './common';

contract('Erc20Escrow', async (accounts) => {
    var mainAccount = web3.utils.toChecksumAddress(accounts[0]);
    var testToken: TestTokenInstance;
    var TSS: TestSigningService;
    var gasMeter: GasMeter;

    var escrowFactory: EscrowFactoryWithERC20Instance;
    var escrowLibrary: EscrowLibraryInstance;

    before(async () => {
        escrowFactory = await EscrowFactoryWithERC20.new({ gas: GAS_LIMIT_FACTORY_DEPLOY });
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
        const args = web3.eth.abi.encodeParameters(['address', 'address'], [escrowLibrary.address, testToken.address]).slice(2);
        const erc20EscrowBytecodeWithConstructorArgs = `${Erc20EscrowBytecode}${args}`;

        var escrowParams = createNewEscrowParams(TSS, escrowAmount, escrowTimelock);
        var escrowAddress = computeCreate2Address(getParamsHash(escrowParams, escrowFactory.address, testToken.address), erc20EscrowBytecodeWithConstructorArgs, escrowFactory.address);

        // Transfer the tokens on behalf of mainAccount to the escrow address
        var txResult = await testToken.transfer(escrowAddress, escrowAmount, {from: mainAccount});
        gasMeter.TrackGasUsage("ERC20 token transfer", txResult.receipt);

        var escrow = await deployERC20EscrowFromFactory(testToken.address, escrowParams);
        assert.equal(escrowAddress, escrow.address);

        return escrow;
    }

    async function getEscrowParams(escrowAddress: string): Promise<EscrowParams> {
        return (await escrowLibrary.escrows(escrowAddress)) as any;
    }

    async function deployERC20EscrowFromFactory(tknAddr: string, escrowParams: EscrowParams) : Promise<Erc20EscrowInstance> {
        var txResult = await escrowFactory.createErc20Escrow(
            tknAddr,
            escrowParams.escrowAmount,
            escrowParams.escrowTimelock,
            escrowParams.escrowerReserve,
            escrowParams.escrowerTrade,
            escrowParams.escrowerRefund,
            escrowParams.payeeReserve,
            escrowParams.payeeTrade,
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
        assert.equal(escrowParams.escrowerRefund, TSS.eRefund.address);
        assert.equal(escrowParams.escrowerTrade, TSS.eTrade.address);
        assert.equal(escrowParams.payeeTrade, TSS.pTrade.address);
        assert.equal(escrowParams.escrowerReserve, TSS.eReserve.address);
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

    it("Force refund fails before expiry", async () => {
        var escrow = await setupERC20Escrow(1000, getCurrentTimeUnixEpoch());

        try {
            await escrowLibrary.forceRefund(escrow.address);
            fail("Force refunding escrow before it has expired should fail");
        } catch(err) {
            assert.match(err, new RegExp("Escrow force refund timelock not reached"));
        }
    });

    it("Force refund an escrow after it expires", async () => {
        var escrow = await setupERC20Escrow(1000, getCurrentTimeUnixEpoch() - FORCE_REFUND_TIMELOCK);
        await escrowLibrary.forceRefund(escrow.address);

        assert.isTrue(new BigNumber(1000).isEqualTo(await testToken.balanceOf(TSS.eReserve.address)), "final escrower reserve balance");
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
        var solvePuzzleResp = await escrowLibrary.solvePuzzle(escrow.address, preimage);
        gasMeter.TrackGasUsage("solvePuzzle", solvePuzzleResp.receipt);

        var withdrawEscrowerResp = await escrowLibrary.withdraw(escrow.address, true);
        gasMeter.TrackGasUsage("withdraw escrower", withdrawEscrowerResp.receipt);

        var withdrawPayeeResp = await escrowLibrary.withdraw(escrow.address, false);
        gasMeter.TrackGasUsage("withdraw payee", withdrawPayeeResp.receipt);
        
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
        var refundPuzzleResp = await escrowLibrary.refundPuzzle(escrow.address);
        gasMeter.TrackGasUsage("refundPuzzle", refundPuzzleResp.receipt);

        var withdrawEscrowerResp = await escrowLibrary.withdraw(escrow.address, true);
        gasMeter.TrackGasUsage("withdraw escrower", withdrawEscrowerResp.receipt);

        var withdrawPayeeResp = await escrowLibrary.withdraw(escrow.address, false);
        gasMeter.TrackGasUsage("withdraw payee", withdrawPayeeResp.receipt);

        assert.isTrue(new BigNumber(800).isEqualTo(await testToken.balanceOf(TSS.eReserve.address)), "final escrower reserve balance");
        assert.isTrue(new BigNumber(200).isEqualTo(await testToken.balanceOf(TSS.pReserve.address)), "final payee reserve balance");
    });
});