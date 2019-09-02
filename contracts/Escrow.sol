pragma solidity ^0.5.0;

import "openzeppelin-solidity/contracts/token/ERC20/ERC20.sol";

import "./EscrowLibrary.sol";
import "./EscrowCommon.sol";


/**
* @title CWC Escrow Contract
* @dev Implementation of a CWC unidirectional escrow payment channel
* @dev Abstract contract with methods that must be implemented for either ETH
* or ERC20 tokens in derived contracts
*/
contract Escrow is EscrowCommon {

    address public escrowLibrary;

    // Mutable state
    EscrowState public escrowState;

    /**
    * @dev Method should only be callable by the escrow library contract that is
    * associated with this escrow
    */
    modifier onlyLibrary() {
        require(msg.sender == escrowLibrary, "Only callable by library contract");
        _;
    }

    constructor(address _escrowLibrary) internal {
        escrowLibrary = _escrowLibrary;
    }

    function setState(EscrowState state) public onlyLibrary {
        escrowState = state;
    }

    /**
    * @dev Abstract methods that must be implemented by derived classes
    */
    function closeEscrow(address payable escrowReserve, address payable payeeReserve) public;
    function sendToEscrower(address payable escrowReserve, uint _amt) public;
    function sendToPayee(address payable payeeReserve, uint _amt) public;
}


/**
* @title CWC Escrow Contract backed by ETH
*/
contract EthEscrow is Escrow {

    uint public escrowerBalance;
    uint public payeeBalance;

    constructor(address escrowLibrary) public Escrow(escrowLibrary) { }

    function () external payable inState(escrowState, EscrowState.Unfunded) {
       EscrowLibrary(escrowLibrary).checkFunded(this);
    }

    function closeEscrow(address payable escrowReserve, address payable payeeReserve) public onlyLibrary {
        // Below we use send rather than transfer because we do not want to have an exception throw
        // Regardless of who is mallicious, all remianing funds will be self-destrcuted
        // the escrower
        escrowReserve.send(escrowerBalance);
        payeeReserve.send(payeeBalance);
        selfdestruct(escrowReserve);
    }

    function sendToEscrower(address payable escrowReserve, uint _amt) public onlyLibrary {
        escrowerBalance += _amt;
    }

    function sendToPayee(address payable payeeReserve, uint _amt) public onlyLibrary {
        payeeBalance += _amt;
    }
}


/**
* @title CWC Escrow Contract backed by a ERC20 token
* @dev Escrow starts in the Unfunded state and only moves to Open once the
* `fundEscrow` function is called which also transfers `escrowAmount` of tokens
* into this contract from a target address that has approved the transfer
*/
contract Erc20Escrow is Escrow {

    ERC20 public token;

    constructor(address escrowLibrary, address tknAddr) public Escrow(escrowLibrary) {
        // Validate the token address implements the ERC 20 standard
        token = ERC20(tknAddr);
    }

    function open(address from, uint amount) public onlyLibrary {
        require(token.transferFrom(from, address(this), amount), "Token Transfer failed");
        setState(EscrowState.Open);
    }

    function closeEscrow(address payable escrowReserve, address payable payeeReserve) public onlyLibrary {
        // If either party is mallicious, all remaining funds are transfered to the escrower regardless of what happens
        selfdestruct(escrowReserve);
    }

    function sendToEscrower(address payable escrowReserve, uint _amt) public onlyLibrary {
        token.transfer(escrowReserve, _amt);
    }

    function sendToPayee(address payable payeeReserve, uint _amt) public onlyLibrary {
        token.transfer(payeeReserve, _amt);
    }
}