# Ethereum Smart Contracts Events Spec

This document outlines the events and RPC calls that are necessary to operate the Arwen trading protocol.

What does what:
 - [Nethereum](https://nethereum.readthedocs.io/en/latest/): simplifying the access and smart contract interaction with Ethereum nodes
 - [Solidity](https://solidity.readthedocs.io/en/v0.4.25/): smart contract scripting language
 - truffle: compile solitity smart contracts
 - ganache: test blockchain provider/explorer


Arwen needs to know:
 - current state of escrow
 - puzzle details (available though public variable query?)
 - 

Current events:
 - PuzzlePosted: empty
 - EscrowClosed: empty

Proposed signatures:
 - PuzzlePosted (string reason)	// Escrow or payee issue?
 - EscrowClosed (string action) // refund, cashout, puzzle, etc...
 - ContractWithdraw (string callee, string currentState) // who called this function? In the case its people outside the ring of participants it would be nice to know

Maintain a history of trades in contract?

Add in public functions for the CLOSED state:
 - Query history of trades
 - Query final state of the contract
 - If contract balance is zero, self destruct?
 - If 24 hours after timelock of contract, send money back automatically and self destruct?


 ## Compiling with Docker

### Installation and requirements
As of writing this note, openzeppelin currently supports solidity 0.5.0. The solidity source code has been refactored for the 0.5.0 solidity compiler.

No need for truffle/solc and vscode stuff, just get the docker to download the compiler and compile the source code:
 - Download and install Docker from the website and make sure docker-cli works with `docker run hello-world`
 - Install openzep-sol with `npm install -g openzeppelin-solidity`; You might need to sudo this.
 - Install desired solc compiler with: `docker run ethereum/solc:0.5.0`
 - Make sure to be in cwc-eth-contracts directory and compile PER FILE
 
 For convince:
 ```
 npm install openzeppelin-solidity		# Instll openzep-sol 0.5.0
 docker run ethereum/solc:0.5.0			# This will detect that you do not have solc docker and install it for you
 docker image ls						# If you have any doubts if solc is the wrong version
 
 # The following will compile Escorw.sol only
 docker run -v $(pwd):/sources ethereum/solc:0.5.0 "openzeppelin-solidity/=/sources/node_modules/openzeppelin-solidity/" --abi --bin --overwrite /sources/contracts/Escrow.sol -o /sources/contracts-bin/				
```