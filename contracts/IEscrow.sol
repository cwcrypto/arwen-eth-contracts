pragma solidity ^0.5.0;


interface IEscrow {
    function balance() external returns (uint);
    function send(address payable addr, uint amt) external returns (bool);
}