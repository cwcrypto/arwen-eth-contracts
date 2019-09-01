const EscrowFactory = artifacts.require("EscrowFactory");

module.exports = function(deployer) {
  var factory = deployer.deploy(EscrowFactory, { gas: 9000000});
};
