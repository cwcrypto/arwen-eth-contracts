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

    // Immutable state (only set once in constructor)
    address public escrowLibrary;
    address payable public escrowReserve;
    address public escrowTrade;
    address public escrowRefund;

    address payable public payeeReserve;
    address public payeeTrade;

    uint public escrowAmount;
    uint public escrowTimelock;

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

    constructor(
        address _escrowLibrary,
        uint _escrowAmt,
        uint _timelock,
        address payable _escrowReserve,
        address _escrowTrade,
        address _escrowRefund,
        address payable _payeeReserve,
        address _payeeTrade
    )
        internal
    {
        escrowLibrary = _escrowLibrary;
        escrowAmount = _escrowAmt;
        escrowTimelock = _timelock;
        escrowReserve = _escrowReserve;
        escrowTrade = _escrowTrade;
        escrowRefund = _escrowRefund;
        payeeReserve = _payeeReserve;
        payeeTrade = _payeeTrade;
    }

    function setState(EscrowState _state) public onlyLibrary {
        escrowState = _state;
    }

    /**
    * @dev Transfers final balances to escrower/payee and self-destructs the escrow
    */
    function closeEscrow() public;

    /**
    * @dev Abstract methods that must be implemented by derived classes
    */
    function sendToEscrower(uint _amt) public;
    function sendRemainingToEscrower() public;
    function sendToPayee(uint _amt) public;
    function sendRemainingToPayee() public;
}


/**
* @title CWC Escrow Contract backed by ETH
* @dev Implementation of a CWC unidirectional escrow payment channel using ETH directly
* @dev Escrow starts in the Open state because it is funded in the constructor
* by sending `escrowAmount` of ETH with the transaction
*/
contract EthEscrow is Escrow {

    uint public escrowerBalance;
    uint public payeeBalance;

    constructor(
        address _escrowLibrary,
        uint _escrowAmt,
        uint _timelock,
        address payable _escrowReserve,
        address _escrowTrade,
        address _escrowRefund,
        address payable _payeeReserve,
        address _payeeTrade
    )
    public
    Escrow(
        _escrowLibrary,
        _escrowAmt,
        _timelock,
        _escrowReserve,
        _escrowTrade,
        _escrowRefund,
        _payeeReserve,
        _payeeTrade
    )
    {
    }

    function () external payable inState(escrowState, EscrowState.Unfunded) {
       EscrowLibrary(escrowLibrary).checkFunded(this);
    }

    function closeEscrow() public onlyLibrary {
        // Below we use send rather than transfer because we do not want to have an exception throw
        // Regardless of who is mallicious, all remianing funds will be self-destrcuted
        // the escrower
        escrowReserve.send(escrowerBalance);
        payeeReserve.send(payeeBalance);
        selfdestruct(escrowReserve);
    }

    function sendToEscrower(uint _amt) public onlyLibrary {
        escrowerBalance += _amt;
    }

    function sendRemainingToEscrower() public onlyLibrary {
        escrowerBalance += address(this).balance - payeeBalance - escrowerBalance;
    }

    function sendToPayee(uint _amt) public onlyLibrary {
        payeeBalance += _amt;
    }

    function sendRemainingToPayee() public onlyLibrary {
        payeeBalance += address(this).balance - payeeBalance - escrowerBalance;
    }
}


/**
* @title CWC Escrow Contract backed by a ERC20 token
* @dev Implementation of a CWC unidirectional escrow payment channel using an arbitrary ERC20 token
* @dev Escrow starts in the Unfunded state and only moves to Open once the
* `fundEscrow` function is called which also transfers `escrowAmount` of tokens
* into this contract from a target address that has approved the transfer
*/
contract Erc20Escrow is Escrow {

    ERC20 public token;

    constructor(
        address _escrowLibrary,
        address _tknAddr,
        uint _tknAmt,
        uint _timelock,
        address payable _escrowReserve,
        address _escrowTrade,
        address _escrowRefund,
        address payable _payeeReserve,
        address _payeeTrade
    )
        public
        payable
    Escrow(
        _escrowLibrary,
        _tknAmt,
        _timelock,
        _escrowReserve,
        _escrowTrade,
        _escrowRefund,
        _payeeReserve,
        _payeeTrade
    )
    {
        // Validate the token address implements the ERC 20 standard
        token = ERC20(_tknAddr);
    }

    function open(address from) public onlyLibrary {
        require(token.transferFrom(from, address(this), escrowAmount), "Token Transfer failed");
        setState(EscrowState.Open);
    }    

    function closeEscrow() public onlyLibrary {
        // If either party is mallicious, all remaining funds are transfered to the escrower regardless of what happens
        selfdestruct(escrowReserve);
    }

    function sendToEscrower(uint _amt) public onlyLibrary {
        token.transfer(escrowReserve, _amt);
    }

    function sendRemainingToEscrower() public onlyLibrary {
        token.transfer(escrowReserve, token.balanceOf(address(this)));
    }

    function sendToPayee(uint _amt) public onlyLibrary {
        token.transfer(payeeReserve, _amt);
    }

    function sendRemainingToPayee() public onlyLibrary {
        token.transfer(payeeReserve, token.balanceOf(address(this)));
    }
}