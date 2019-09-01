// Setup web3 provider to point at local development blockchain spawned by truffle develop
import Web3 from 'web3';
const web3 = new Web3('http://localhost:9545');

// Import truffle contract abstractions
const EscrowFactory = artifacts.require("EscrowFactory");

import { GasMeter } from './common';

contract('Escrow Factory', async (accounts) => {
    var gasMeter: GasMeter;

    beforeEach(async () => {
        gasMeter = new GasMeter();
    });

    afterEach(() => {
        gasMeter.printAggregateGasUsage(false);
    });

    it("Deploy a new contract factory", async() => {
        var factory = await EscrowFactory.new();

        var txReceipt = await web3.eth.getTransactionReceipt(factory.transactionHash);
        gasMeter.TrackGasUsage("Create new factory", txReceipt);
    });
});