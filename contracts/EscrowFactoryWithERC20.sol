pragma solidity ^0.5.0;

import "./EscrowFactory.sol";


contract EscrowFactoryWithERC20 is EscrowFactory {

    // solhint-disable-next-line
    bytes ERC20_ESCROW_BYTECODE = hex"608060405234801561001057600080fd5b506040516105603803806105608339818101604052604081101561003357600080fd5b81019080805190602001909291908051906020019092919050505081806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055505080600160006101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff160217905550505061047e806100e26000396000f3fe608060405234801561001057600080fd5b506004361061004c5760003560e01c806367f31fbb14610051578063b69ef8a81461009b578063d0679d34146100b9578063fc0c546a1461011f575b600080fd5b610059610169565b604051808273ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200191505060405180910390f35b6100a361018e565b6040518082815260200191505060405180910390f35b610105600480360360408110156100cf57600080fd5b81019080803573ffffffffffffffffffffffffffffffffffffffff1690602001909291908035906020019092919050505061026f565b604051808215151515815260200191505060405180910390f35b610127610402565b604051808273ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200191505060405180910390f35b6000809054906101000a900473ffffffffffffffffffffffffffffffffffffffff1681565b6000600160009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff166370a08231306040518263ffffffff1660e01b8152600401808273ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200191505060206040518083038186803b15801561022f57600080fd5b505afa158015610243573d6000803e3d6000fd5b505050506040513d602081101561025957600080fd5b8101908080519060200190929190505050905090565b60008060009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff1614610316576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260218152602001806104296021913960400191505060405180910390fd5b600160009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1663a9059cbb84846040518363ffffffff1660e01b8152600401808373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200182815260200192505050602060405180830381600087803b1580156103bf57600080fd5b505af11580156103d3573d6000803e3d6000fd5b505050506040513d60208110156103e957600080fd5b8101908080519060200190929190505050905092915050565b600160009054906101000a900473ffffffffffffffffffffffffffffffffffffffff168156fe4f6e6c792063616c6c61626c65206279206c69627261727920636f6e7472616374a265627a7a72315820a9d4b475a17ea114134619598c6b6a58e8f77fa98ac34e35808414ebe01c849464736f6c634300050c0032";

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

        bytes memory bytecode = abi.encodePacked(ERC20_ESCROW_BYTECODE, abi.encode(address(escrowLibrary), tknAddr));
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