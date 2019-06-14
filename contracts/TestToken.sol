pragma solidity ^0.5.0;

import "openzeppelin-solidity/contracts/token/ERC20/ERC20.sol";


contract TestToken is ERC20 {

    constructor() public {
        // mint tokens and send them all to the creator of this TestToken contract
        _mint(msg.sender, 10000000);
    }
}