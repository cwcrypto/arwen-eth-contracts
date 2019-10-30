# Arwen Ethereum Contracts

The [Arwen](https://arwen.io/) [protocol](https://arwen.io/whitepaper.pdf) provides secure, decentralized settlement for crypto exchanges and OTC trading between BTC, BCH, LTC and ETH using escrows. These smart contracts enable non-custodial trading with Ethereum. In this repo we also have a smart contract for ERC-20, however [support for ERC-20 has been disabled](https://github.com/cwcrypto/cwc-eth-contracts/commit/7efbabcaee6e75d73f0039c9ea7a06ebad7d262a#diff-7ccd12707c298ee4b06ba765a26034c1) and we have no current plans to support ERC-20.

These smart contracts are written in solidity and can be found in the [contracts/](contracts/) directory. Tests for these smart contracts can be found [test/](test/) and instructions for these tests can be found below in this README.

Our escrow contracts make use of the factory and library pattern. When a party wishes to create a new escrow they call the factory contract ([EscrowFactory.sol](contracts/EscrowFactory.sol)). The factory contract then creates the Arwen escrow contract ([Escrow.sol](contracts/Escrow.sol)). To reduce gas costs the logic for the Arwen escrow smart contract resides in a library contract ([EscrowLibrary.sol](contracts/EscrowLibrary.sol)). Our escrows and library contracts are immutable. We can not change their logic once they are created.

To upgrade our escrow contracts we have the ability to disable the factory contract via the `selfDestruct` method. This prevents the factory contract from creating new escrow contracts without harming existing escrows. We can then deploy a new factory contract which is used to create upgraded escrow contracts. In this way we can upgrade new escrows while not impacting the immutability or behavior of existing escrows. Our escrow and library contracts do not have the `selfDestruct` methods.

To report a security issue or vulnerability see our [SECURITY.md](SECURITY.md).

##

## Quickstart

### Setup

```
npm install -g solhint truffle ganache-cli
npm install
```

### Run Contract Unit Tests

Terminal #1
```
ganache-cli -p 9545 -l 9000000
```

Terminal #2
```
npm run build
npm test
```

## [Solidity](https://solidity.readthedocs.io/en/develop/index.html)

The official solidity documentation is a great resource for both learning solidity from scratch by example and as a comprehensive reference on all the language's features.

### Solidity Style Guide

- See the official solidity [style guide](https://solidity.readthedocs.io/en/develop/style-guide.html#style-guide). Many of these style guide standards are enforced by [solhint](#solhint).
- Comments for contracts and functions should adhere to the ethereum [NatSpec guide](https://solidity.readthedocs.io/en/develop/style-guide.html#natspec) which uses doxygen-like comments.

## Development Environment

### [Vscode solidity extension](https://github.com/juanfranblanco/vscode-solidity)

- Syntax highlighting and code completion.
- As-you-type-compile errors
- Linting with solhint

### [Solhint](https://github.com/protofire/solhint)

Currently using solhint which is an open source solidity linter providing both **security** and **style guide** validations. Rules can be configured from the `.solhint.json` file. You should install solhint globally with `npm install -g solhint`.


### [Ganache](https://truffleframework.com/docs/ganache/quickstart)

Ganache is a test blockchain provider/explorer. Ganache has a block explorer GUI that can be installed as well as [ganache-cli](https://github.com/trufflesuite/ganache-cli/blob/master/README.md). `ganache-cli` gives you many more configuration options when launching the test blockchain as well as being able to see all underlying RPC calls.

```
npm install -g ganache-cli
ganache-cli -p 9545
```

### [Truffle](https://truffleframework.com/docs/truffle/overview)

Truffle is an ethereum smart contract development toolchain with many awesome features. You should install truffle globally with `npm install -g truffle`.

#### Features

- Compile and deploy solidity contracts
- Create js abstractions that can be used to interact with deployed contracts
- Importing solidity libraries that are installed as npm modules
- Migrations for managing deployments of smart contracts
- EVM debugger

#### Truffle Configuration

Truffle can be configured using the config file in the root directory: `truffle-config.js`.

- `networks`: This configuration tells truffle which RPC server to connect to when deploying contracts or sending transactions to contracts. It can be set to a local development blockchain for testing but also configured to talk to an ethereum node over RPC on a private network, testnet, or mainnet.
- `solc`: Allows you to specify a specific solc compiler version that will be used for `truffle compile` which will be automatically fetched if you change the version. See [here](https://truffleframework.com/docs/truffle/reference/configuration#compiler-configuration) for more details. To list all available solc versions from solc-bin `truffle compile --list`.

## Imported Solidity Libraries

Currently we import contracts from [open-zepplin](https://github.com/OpenZeppelin/openzeppelin-solidity). This is an open source repository of well audited smart contracts to use/inherit from in dependent contracts. Contracts can be directly imported by truffle when you specify the path from the openzepplin-solidity node module:

```solidity
import "openzeppelin-solidity/contracts/token/ERC20/ERC20.sol";
```

See [here](https://truffleframework.com/docs/truffle/getting-started/package-management-via-npm) for more details on how truffle works with solidity npm modules.

## Solc

### Version

The current version of solidity we are using is `0.5.9`. Note this is the latest major version `0.5` of solidty with additional safety features that also introduced some [breaking changes](https://solidity.readthedocs.io/en/develop/050-breaking-changes.html) compared to `0.4`.

### Solc with truffle

It is included as a dependency of the [truffle](#Truffle) and the version used by `truffle compile` is managed by `truffle-config.js`.

### Solc with vscode-solidity

The version of the compiler used by the vscode extension is currently overriden to be `0.5.9` by including the solc npm module at that version. See [here](https://github.com/juanfranblanco/vscode-solidity#using-a-different-version-of-the-solidity-compiler) for more details.

## NPM scripts

These are located in the `package.json` file.

- `npm run build`: This script will run `truffle compile` in addition to running the solhint linter, and generating typechain typescript definitions for all contracts to be used in testing. Anytime you change any solidity contract file you should rerun this command.
- `npm run solhint`: Run just the solhint linter on all contracts
- `npm test`: Just an alias for `truffle test` at the moment which runs the contract unit tests

## Project File Structure

- `contracts`: All solidity (.sol) source files.
- `test`: Tests for the contracts written in typescript and utilizing web3.js and truffle's contract abstractions. See [test section](#testing) for more details.

## Testing

Contract unit tests can be written in typescript using the `mocha` test runner and `chai` assertion library. The Truffle testing environment leverages truffle's [contract abstractions](https://github.com/trufflesuite/truffle-contract) to deploy/interact with smart contracts on the blockchain.

### [Typechain](https://github.com/ethereum-ts/TypeChain)

This module automatically generates typescript definintion files for your compiled smart contracts. It can be configured to target truffle's contract build artifacts. This project was based on the boiler-plate truffle-typechain [sample project](https://github.com/ethereum-ts/truffle-typechain-example).

### Other Testing Resources

- [Truffle testing](https://truffleframework.com/docs/truffle/testing/writing-tests-in-javascript)
- [Chai Assertions](https://www.chaijs.com/api/assert/)
