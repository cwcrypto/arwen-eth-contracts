# Arwen Ethereum Contracts

The Arwen protocol provides secure, decentralized settlement for crypto exchanges and OTC trading between BTC, BCH, LTC and ETH using escrows. This smart contract is used to support trading escrows which trade from or to Ethereum. In this repo we also have a smart contract for ERC-20, however [support for ERC-20 has been disabled](https://github.com/cwcrypto/cwc-eth-contracts/commit/7efbabcaee6e75d73f0039c9ea7a06ebad7d262a#diff-7ccd12707c298ee4b06ba765a26034c1) and we have no current plans to support ERC-20.

These smart contracts are written in solidity and can be found in the [contracts/](contracts/) directory. Tests for these smart contracts can be found [tests/](tests/) and instructions for these tests can be found below in this README.

Our escrow contracts make use of the factory and library pattern. Thus, when a party wishes to create a new escrow, they call the factory contract ([EscrowFactory.sol](contracts/EscrowFactory.sol)) which in turn creates the Arwen escrow contract ([Escrow.sol](contracts/Escrow.sol)). To reduce gas costs the logic for the Arwen escrow smart contract lives in a library contract ([EscrowLibrary.sol](contracts/EscrowLibrary.sol)). Our escrows and library contracts are immutable. We can not change their logic once they are created.

To upgrade our escrow contracts we have ability to disable the factory contract such that it can no longer create new escrow contracts using the `selfDestruct` method. We can then deploy a new factory contract which will can be used to create upgraded escrow contracts. In this way, we can upgrade new escrows, while not impacting the immutability or behavior of existing escrows. Our escrow and library contracts do not have `selfDestruct` methods.

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

Solidity is a language for programming ethereum smart contracts. An ethereum smart contract is simply a program with some associated state that is stored on the ethereum blockchain. The program's code is intialized when the contract is created and is immutable. The smart contract's state is mutable but only through the contract's code. The program is executed on the Etherem Virtual Machine (EVM) which is specified as part of the ethereum blockchain's consensus rules. Solidity is a high level language that compiles down to EVM byte-code.

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

#### Common Truffle Commands

`truffle compile`: This will compile all .sol files within the `contracts` directory. Outputs build artifacts in `build` directory.

`truffle test`: Runs all unit test files in the `test` directory. See [testing](#testing) section.

`truffle develop`: This will under-the-hood launch `ganache` on port 9545. In addition this will open an interactive console that can be used to interact with the development blockchain and any deployed contracts. [See here for more details](https://truffleframework.com/docs/truffle/getting-started/using-truffle-develop-and-the-console).

`truffle migrate`: Runs the migration scripts found in the `migrations` directory. These can be used for managing deployment of many dependent contracts, deploying contracts to different environments (development, private, testnet, mainnet). Currently the migration folder only has the boiler-plate migration scripts `truffle migrate` uses internally.

`truffle debug`: Allows stepping through evm code execution of any transaction. You need to provide the txid of the transaction which you can get from the `ganache-cli` logs or by printing it to the console from the typescript tests.

## Imported Solidity Libraries

Currently we import contracts from [open-zepplin](https://github.com/OpenZeppelin/openzeppelin-solidity). This is an open source repository of well audited smart contracts to use/inherit from in dependent contracts. Contracts can be directly imported by truffle when you specify the path from the openzepplin-solidity node module:

```solidity
import "openzeppelin-solidity/contracts/token/ERC20/ERC20.sol";
```

See [here](https://truffleframework.com/docs/truffle/getting-started/package-management-via-npm) for more details on how truffle works with solidity npm modules.

## Solc

Solc is the solidity compiler. It is possible install and run the solc compiler separately [see here](https://solidity.readthedocs.io/en/develop/installing-solidity.html). This version of the solc compiler has many additional features including being able to show gas estimates for your contracts in order to benchmark and tune your solidity contracts for gas usage.

To generate gas estimates for a contract use the `solc --gas <contract.sol>`. However if any external solidity imports are made in your file that are not in the current directory you have to setup the import paths that the solc uses. For example importing the openzepplin-solidity contracts requires mapping the `openzepplin-solidity` import path to its location in node_modules.

```
solc --gas openzeppelin-solidity/=<full-path-to-cwc-eth-contracts>/node_modules/openzeppelin-solidity/ contracts/Escrow.sol
```

However there are some limitations with the gas estimator that may cause it to show infinite estimates for some functions see this [post](https://ethereum.stackexchange.com/a/29637) for details.

### Solc with truffle

It is included as a dependency of the [truffle](#Truffle) and the version used by `truffle compile` is managed by `truffle-config.js`.

### Solc with vscode-solidity

The version of the compiler used by the vscode extension is currently overriden to be `0.4.25` by also including the solc npm module at that version. See [here](https://github.com/juanfranblanco/vscode-solidity#using-a-different-version-of-the-solidity-compiler) for more details.

### Version

The current version of solidity we are using is `0.5.9`. Note this is the latest major version `0.5` of solidty with additional safety features that also introduced some [breaking changes](https://solidity.readthedocs.io/en/develop/050-breaking-changes.html) compared to `0.4`.

## NPM scripts

These are located in the `package.json` file.

- `npm run build`: This script will run `truffle compile` in addition to running the solhint linter, and generating typechain typescript definitions for all contracts to be used in testing. Anytime you change any solidity contract file you should rerun this command.
- `npm run solhint`: Run just the solhint linter on all contracts
- `npm test`: Just an alias for `truffle test` at the moment which runs the contract unit tests

## Project File Structure

- `contracts`: All solidity (.sol) source files.
- `migrations`: Migration scripts used by `truffle migrate` command.
- `test`: Tests for the contracts written in typescript and utilizing web3.js and truffle's contract abstractions. See [test section](#testing) for more details.

### Auto-generated (gitignored)

- `node_modules`: node dependencies (from `package.json`). Run `npm install` to make sure all dependencies are installed.
- `build`: This directory is created to store build artifacts once you run `truffle compile`. It contains the ABIs of the contracts as well as metadata used by truffle's migration/deployment features.
- `types`: This directory is created by Typechain and contains auto-generated typescript definitions for compiled contracts.

## Testing

Contract unit tests can be written in typescript using the `mocha` test runner and `chai` assertion library. The Truffle testing environment leverages truffle's [contract abstractions](https://github.com/trufflesuite/truffle-contract) to deploy/interact with smart contracts on the blockchain.

### Web3.js

The [web3.js@1.0](https://web3js.readthedocs.io/en/1.0/index.html) module contains many useful ethereum utilities for:

- Querying balances of ethereum addresses
- ABI encoding data
- Crypto utils for hashing, generating keys, signing data

### [Typechain](https://github.com/ethereum-ts/TypeChain)

This module automatically generates typescript definintion files for your compiled smart contracts. It can be configured to target truffle's contract build artifacts. This project was based on the boiler-plate truffle-typechain [sample project](https://github.com/ethereum-ts/truffle-typechain-example).

### Typescript Modules

- @types/mocha: Types for mocha testing framework
- @types/node: Types for node.js standard library
- @types/bignumber.js: Types for js big number library which is used by web3.js
- truffle-typings: Types for truffle utilities

### Other Testing Resources

- [Truffle testing](https://truffleframework.com/docs/truffle/testing/writing-tests-in-javascript)
- [Chai Assertions](https://www.chaijs.com/api/assert/)
