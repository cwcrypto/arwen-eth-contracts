pragma solidity ^0.5.0;

import "./Escrow.sol";
import "./EscrowLibrary.sol";
import "openzeppelin-solidity/contracts/ownership/Ownable.sol";


contract EscrowFactory is Ownable {

    EscrowLibrary public escrowLibrary;

    constructor () public {
        escrowLibrary = new EscrowLibrary();
    }

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
            address(escrowLibrary),
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
            address(escrowLibrary),
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

    function selfDestruct() public onlyOwner {
        selfdestruct(msg.sender);
    }
}
