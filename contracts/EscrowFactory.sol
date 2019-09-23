pragma solidity ^0.5.0;

import "./Escrow.sol";
import "./EscrowLibrary.sol";
import "openzeppelin-solidity/contracts/ownership/Ownable.sol";


contract EscrowFactory is Ownable {

    EscrowLibrary public escrowLibrary;

    mapping (bytes32 => bool) public escrowsCreated;

    constructor () public {
        escrowLibrary = new EscrowLibrary();
    }

    event EscrowCreated(
        bytes32 indexed escrowParams,
        address escrowAddress
    );

    function createEthEscrow(
        uint escrowAmount,
        uint timelock,
        address payable escrowReserve,
        address escrowTrade,
        address escrowRefund,
        address payable payeeReserve,
        address payeeTrade
    )
    public
    {
        bytes32 escrowParamsHash = keccak256(abi.encodePacked(
            address(this),
            escrowAmount,
            timelock,
            escrowReserve,
            escrowTrade,
            escrowRefund,
            payeeReserve,
            payeeTrade
        ));

        require(! escrowsCreated[escrowParamsHash], "Escrow params hash already exists");

        escrowsCreated[escrowParamsHash] = true;

        EthEscrow escrow = new EthEscrow(
            address(escrowLibrary)
        );

        escrowLibrary.registerEscrow(
            address(escrow),
            escrowAmount,
            timelock,
            escrowReserve,
            escrowTrade,
            escrowRefund,
            payeeReserve,
            payeeTrade,
            false
        );

        emit EscrowCreated(escrowParamsHash, address(escrow));
    }

    function createErc20Escrow(
        address tknAddr,
        uint escrowAmount,
        uint timelock,
        address payable escrowReserve,
        address escrowTrade,
        address escrowRefund,
        address payable payeeReserve,
        address payeeTrade
    )
    public
    {
        bytes32 escrowParamsHash = keccak256(abi.encodePacked(
            address(this),
            tknAddr,
            escrowAmount,
            timelock,
            escrowReserve,
            escrowTrade,
            escrowRefund,
            payeeReserve,
            payeeTrade
        ));

        require(! escrowsCreated[escrowParamsHash], "Escrow params hash already exists");

        escrowsCreated[escrowParamsHash] = true;

        Erc20Escrow escrow = new Erc20Escrow(
            address(escrowLibrary),
            tknAddr
        );

        escrowLibrary.registerEscrow(
            address(escrow),
            escrowAmount,
            timelock,
            escrowReserve,
            escrowTrade,
            escrowRefund,
            payeeReserve,
            payeeTrade,
            true
        );

        emit EscrowCreated(escrowParamsHash, address(escrow));
    }

    function selfDestruct() public onlyOwner {
        selfdestruct(msg.sender);
    }
}
