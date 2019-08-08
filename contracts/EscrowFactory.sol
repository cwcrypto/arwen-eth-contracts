pragma solidity ^0.5.0;

import "openzeppelin-solidity/contracts/math/SafeMath.sol";
import "./Escrow.sol";


contract EscrowFactory {
    constructor () public {}

    event EscrowCreated(
        bytes32 indexed escrowParams,
        address escrowAddress
    );

    function createEthEscrow(
        uint _escrowAmount,
        uint _timelock,
        address payable _escrowReserve,
        address _escrowTrade,
        address _escrowRefund,
        address payable _payeeReserve,
        address _payeeTrade
    )
    public
    {
        EthEscrow escrow = new EthEscrow(
            _escrowAmount,
            _timelock,
            _escrowReserve,
            _escrowTrade,
            _escrowRefund,
            _payeeReserve,
            _payeeTrade
        );

        bytes32 escrowParamsHash = keccak256(abi.encodePacked(
            address(this),
            _escrowAmount,
            _timelock,
            _escrowReserve,
            _escrowTrade,
            _escrowRefund,
            _payeeReserve,
            _payeeTrade
        ));

        emit EscrowCreated(escrowParamsHash, address(escrow));
    }

    function createErc20Escrow(
        address _tknAddr,
        uint _escrowAmount,
        uint _timelock,
        address payable _escrowReserve,
        address _escrowTrade,
        address _escrowRefund,
        address payable _payeeReserve,
        address _payeeTrade
    )
    public
    {
        Erc20Escrow escrow = new Erc20Escrow(
            _tknAddr,
            _escrowAmount,
            _timelock,
            _escrowReserve,
            _escrowTrade,
            _escrowRefund,
            _payeeReserve,
            _payeeTrade
        );

        bytes32 escrowParamsHash = keccak256(abi.encodePacked(
            address(this),
            _tknAddr,
            _escrowAmount,
            _timelock,
            _escrowReserve,
            _escrowTrade,
            _escrowRefund,
            _payeeReserve,
            _payeeTrade
        ));

        emit EscrowCreated(escrowParamsHash, address(escrow));
    }
}
