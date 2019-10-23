pragma solidity ^0.5.0;

import "openzeppelin-solidity/contracts/token/ERC20/ERC20.sol";
import "./EscrowLibrary.sol";


/**
* Thin wrapper around a ETH/ERC20 payment channel deposit that is controlled
* by a library contract for the purpose of trading with atomic swaps using the
* Arwen protocol.
* @dev Abstract contract with `balance` and `send` methods that must be implemented
* for either ETH or ERC20 tokens in derived contracts. The `send` method should only
* callable by the library contract that controls this escrow
*/
contract Escrow {

    address public escrowLibrary;

    modifier onlyLibrary() {
        require(msg.sender == escrowLibrary, "Only callable by library contract");
        _;
    }

    constructor(address _escrowLibrary) internal {
        escrowLibrary = _escrowLibrary;
    }

    function balance() public returns (uint);
    function send(address payable addr, uint amt) public returns (bool);
}


/**
* Escrow Contract backed by ETH
*/
contract EthEscrow is Escrow {

    constructor(address escrowLibrary) public Escrow(escrowLibrary) { }

    /**
    * Payable fallback method that allows the escrow to be funded and triggers
    * a `checkFunded` call on the library contract to emit an event when the
    * escrow becomes fully funded
    */
    function () external payable {
       EscrowLibrary(escrowLibrary).checkFunded(address(this));
    }

    function send(address payable addr, uint amt) public onlyLibrary returns (bool) {
        return addr.send(amt);
    }

    function balance() public returns (uint) {
        return address(this).balance;
    }
}


/**
* Escrow Contract backed by a ERC20 token
*/
contract Erc20Escrow is Escrow {

    ERC20 public token;

    constructor(address escrowLibrary, address tknAddr) public Escrow(escrowLibrary) {
        // Validate the token address implements the ERC20 standard
        token = ERC20(tknAddr);
    }

    function send(address payable addr, uint amt) public onlyLibrary returns (bool) {
        return token.transfer(addr, amt);
    }

    function balance() public returns (uint) {
        return token.balanceOf(address(this));
    }
}