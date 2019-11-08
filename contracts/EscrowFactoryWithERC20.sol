pragma solidity ^0.5.0;

import "./Escrow.sol";
import "./EscrowFactory.sol";


contract EscrowFactoryWithERC20 is EscrowFactory {

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

        bytes memory constructorArgs = abi.encode(address(escrowLibrary), tknAddr);
        bytes memory bytecode = abi.encodePacked(type(Erc20Escrow).creationCode, constructorArgs);
        address escrowAddress = createEscrow(bytecode, escrowParamsHash);

        escrowLibrary.newEscrow(
            escrowAddress,
            escrowAmount,
            timelock,
            escrowerReserve,
            escrowerTrade,
            escrowerRefund,
            payeeReserve,
            payeeTrade
        );

        emit EscrowCreated(escrowParamsHash, escrowAddress);
    }
}