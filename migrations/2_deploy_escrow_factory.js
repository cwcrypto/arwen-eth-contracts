const EscrowFactoryWithERC20 = artifacts.require("EscrowFactoryWithERC20");
const EscrowFactory = artifacts.require("EscrowFactory");

module.exports = function(deployer) {
    var factory = deployer.deploy(EscrowFactory, { gas: 9000000});
    var factoryWithERC20 = deployer.deploy(EscrowFactoryWithERC20, { gas: 9000000});
};
