// Setup web3 provider to point at local development blockchain spawned by truffle develop
import Web3 from 'web3';
const web3 = new Web3('http://localhost:9545');

// Import truffle contract abstractions
const EscrowFactory = artifacts.require("EscrowFactory");
const EscrowFactoryWithERC20 = artifacts.require("EscrowFactoryWithERC20");

import { GasMeter, GAS_LIMIT_FACTORY_DEPLOY, computeCreate2Address } from './common';

contract('Escrow Factory', async (accounts) => {
    var gasMeter: GasMeter;

    beforeEach(async () => {
        gasMeter = new GasMeter();
    });

    afterEach(() => {
        gasMeter.printAggregateGasUsage(false);
    });

    it("Deploy a new ETH contract factory", async() => {

        // Override gas since deploying factory takes more than default gas limit and block limit
        var factory = await EscrowFactory.new({ gas: GAS_LIMIT_FACTORY_DEPLOY });
        var txReceipt = await web3.eth.getTransactionReceipt(factory.transactionHash);
        gasMeter.TrackGasUsage("Create new factory", txReceipt);
    });

    it("Deploy a new contract factory with ERC20", async() => {

        // Override gas since deploying factory takes more than default gas limit and block limit
        var factory = await EscrowFactoryWithERC20.new({ gas: GAS_LIMIT_FACTORY_DEPLOY });
        var txReceipt = await web3.eth.getTransactionReceipt(factory.transactionHash);
        gasMeter.TrackGasUsage("Create new factory", txReceipt);
    });
});