pragma solidity ^0.5.0;

import "./Escrow.sol";
import "./EscrowLibrary.sol";
import "openzeppelin-solidity/contracts/ownership/Ownable.sol";


contract EscrowFactory is Ownable {

    EscrowLibrary public escrowLibrary;
    mapping(bytes32 => bool) internal escrowsCreated;

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
        address payable escrowerReserve,
        address escrowerTrade,
        address escrowerRefund,
        address payable payeeReserve,
        address payeeTrade
    )
    public
    {
        bytes32 escrowParamsHash = keccak256(abi.encodePacked(
            address(this),
            escrowAmount,
            timelock,
            escrowerReserve,
            escrowerTrade,
            escrowerRefund,
            payeeReserve,
            payeeTrade
        ));

        require(! escrowsCreated[escrowParamsHash], "escrow already exists");
        
        EthEscrow escrow = new EthEscrow(
            address(escrowLibrary)
        );

        escrowLibrary.newEscrow(
            address(escrow),
            escrowAmount,
            timelock,
            escrowerReserve,
            escrowerTrade,
            escrowerRefund,
            payeeReserve,
            payeeTrade
        );

        escrowsCreated[escrowParamsHash] = true;

        emit EscrowCreated(escrowParamsHash, address(escrow));
    }

    function createErc20Escrow(
        address tknAddr,
        uint escrowAmount,
        uint timelock,
        address payable escrowerReserve,
        address escrowerTrade,
        address escrowerRefund,
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
            escrowerReserve,
            escrowerTrade,
            escrowerRefund,
            payeeReserve,
            payeeTrade
        ));

        require(! escrowsCreated[escrowParamsHash], "escrow already exists");

        escrowsCreated[escrowParamsHash] = true;

        Erc20Escrow escrow = new Erc20Escrow(
            address(escrowLibrary),
            tknAddr
        );

        escrowLibrary.newEscrow(
            address(escrow),
            escrowAmount,
            timelock,
            escrowerReserve,
            escrowerTrade,
            escrowerRefund,
            payeeReserve,
            payeeTrade
        );

        emit EscrowCreated(escrowParamsHash, address(escrow));
    }

    function selfDestruct() public onlyOwner {
        selfdestruct(msg.sender);
    }
}
