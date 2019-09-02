pragma solidity ^0.5.0;

import "./Escrow.sol";
import "./EscrowCommon.sol";
import "openzeppelin-solidity/contracts/cryptography/ECDSA.sol";


contract EscrowLibrary is EscrowCommon {

    string constant SIGNATURE_PREFIX = '\x19Ethereum Signed Message:\n';

    enum MessageTypeId {
        None,
        Cashout,
        Puzzle,
        Refund
    }

    /**
    * @dev Possible reasons the escrow can become closed (sink state of the
    * escrow where the contract is also self-destructed)
    */
    enum EscrowCloseReason {
        Refund,
        PuzzleRefund,
        PuzzleSolve,
        Cashout
    }

    // Events
    event EscrowOpened(address indexed escrow);
    event EscrowFunded(address indexed escrow, uint amountFunded);
    event PuzzlePosted(address indexed escrow, bytes32 puzzle);
    event Preimage(address indexed escrow, bytes32 preimage);
    event EscrowClosed(address indexed escrow, EscrowCloseReason reason, bytes32 sighash);

    struct EscrowParams {
        uint escrowAmount;
        uint escrowTimelock;
        address escrowTrade;
        address escrowRefund;
        address payeeTrade;
        bool isErc20;
    }

    struct PuzzleParams {
        bytes32 puzzle;
        uint puzzleTimelock;
        bytes32 puzzleSighash;
    }

    address public escrowFactory;
    mapping(address => PuzzleParams) public postedPuzzles;
    mapping(address => EscrowParams) public escrows;

    constructor() public {
        escrowFactory = msg.sender;
    }

    modifier onlyFactory() {
        require(msg.sender == escrowFactory, "Can only be called by escrow factory");
        _;
    }

    function sendRemainingToEscrower(address payable escrowAddress, EscrowParams memory escrowParams) internal {
        if(escrowParams.isErc20) {
            Erc20Escrow erc20Escrow = Erc20Escrow(escrowAddress);
            erc20Escrow.sendToEscrower(erc20Escrow.token().balanceOf(escrowAddress));
        } else {
            EthEscrow ethEscrow = EthEscrow(escrowAddress);
            ethEscrow.sendToEscrower(
                address(escrowAddress).balance - ethEscrow.payeeBalance() - ethEscrow.escrowerBalance()
            );
        }
    }

    function sendRemainingToPayee(address payable escrowAddress, EscrowParams memory escrowParams) internal {
         if(escrowParams.isErc20) {
            Erc20Escrow erc20Escrow = Erc20Escrow(escrowAddress);
            erc20Escrow.sendToPayee(erc20Escrow.token().balanceOf(escrowAddress));
        } else {
            EthEscrow ethEscrow = EthEscrow(escrowAddress);
            ethEscrow.sendToPayee(escrowAddress.balance - ethEscrow.payeeBalance() - ethEscrow.escrowerBalance());
        }
    }

    function checkFunded(EthEscrow escrow) public {
        emit EscrowFunded(address(escrow), address(escrow).balance);
    }

    function registerEscrow(
        address escrow,
        uint escrowAmount,
        uint timelock,
        address escrowTrade,
        address escrowRefund,
        address payeeTrade,
        bool isErc20
    )
        public
        onlyFactory
    {
        escrows[address(escrow)] = EscrowParams(
            escrowAmount,
            timelock,
            escrowTrade,
            escrowRefund,
            payeeTrade,
            isErc20 = isErc20
        );
    }

    /**
    * @dev Moves an Eth Escrow into the Open state if escrow has been funded
    */
    function openEthEscrow(
        EthEscrow escrow
    )
        public
        inState(escrow.escrowState(), EscrowState.Unfunded)
    {
        EscrowParams memory escrowParams = escrows[address(escrow)];

        uint escrowAmount = escrowParams.escrowAmount;
        uint escrowBalance = address(escrow).balance;

        require(escrowBalance >= escrowAmount, "Escrow not funded");
        if(escrowBalance > escrowAmount) {
            escrow.sendToEscrower(escrowBalance - escrowAmount);
        }

        escrow.setState(EscrowState.Open);
        emit EscrowOpened(address(escrow));
    }

    /**
    * Attempts to transfer escrowAmount into this contract
    * @dev Will fail unless the from address has approved this contract to
    * transfer at least `escrowAmount` using the `approve` method of the token
    * contract
    * @param from The address to transfer the tokens from
    */
    function openERC20Escrow(
        Erc20Escrow escrow,
        address from
    )
        public 
        inState(escrow.escrowState(), EscrowState.Unfunded)
    {
        EscrowParams memory escrowParams = escrows[address(escrow)];

        escrow.open(from, escrowParams.escrowAmount);
        emit EscrowOpened(address(escrow));
    }

    /** Cashout the escrow sending the final balances after trading
    * @dev Must be signed by both the escrower and payee trade keys
    * @dev Must be in Open state
    * @param prevAmountTraded The total amount traded to the payee in the
    * payment channel
    */
    function cashout(
        address payable escrowAddress,
        uint prevAmountTraded,
        bytes memory eSig,
        bytes memory pSig
    )
        public
        inState(Escrow(escrowAddress).escrowState(), EscrowState.Open)
    {
        Escrow escrow = Escrow(escrowAddress);
        EscrowParams memory escrowParams = escrows[address(escrow)];

        // Length of the actual message: 20 + 1 + 32
        string memory messageLength = '53';
        bytes32 sighash = keccak256(abi.encodePacked(
            SIGNATURE_PREFIX,
            messageLength,
            address(escrow),
            uint8(MessageTypeId.Cashout),
            prevAmountTraded
        ));

        // Check signatures
        require(verify(sighash, eSig) == escrowParams.escrowTrade, "Invalid escrower cashout sig");
        require(verify(sighash, pSig) == escrowParams.payeeTrade, "Invalid payee cashout sig");

        escrow.sendToPayee(prevAmountTraded);
        sendRemainingToEscrower(escrowAddress, escrowParams);

        emit EscrowClosed(address(escrow), EscrowCloseReason.Refund, sighash);
        escrow.closeEscrow();
    }

    /** Allows the escrower to refund the escrow after the `escrowTimelock` has been reached
    * @dev Must be signed by the escrower refund key
    * @dev Must be in Open state
    * @param prevAmountTraded The total amount traded to the payee in the
    * payment channel
    */
    function refund(
        address payable escrowAddress,
        uint prevAmountTraded,
        bytes memory eSig
    )
        public
        inState(Escrow(escrowAddress).escrowState(), EscrowState.Open)
    {
        Escrow escrow = Escrow(escrowAddress);
        EscrowParams memory escrowParams = escrows[address(escrow)];

        require(now >= escrowParams.escrowTimelock, "Escrow timelock not reached");
        
        // Length of the actual message: 20 + 1 + 32
        string memory messageLength = '53';
        bytes32 sighash = keccak256(abi.encodePacked(
            SIGNATURE_PREFIX,
            messageLength,
            address(escrow),
            uint8(MessageTypeId.Refund),
            prevAmountTraded
        ));

        // Check signature
        require(verify(sighash, eSig) == escrowParams.escrowRefund, "Invalid escrower sig");

        escrow.sendToPayee(prevAmountTraded);
        sendRemainingToEscrower(escrowAddress, escrowParams);

        emit EscrowClosed(address(escrow), EscrowCloseReason.Refund, sighash);
        escrow.closeEscrow();
    }

    /** Post a hash puzzle unlocks lastest trade in the escrow
    * @dev Must be signed by both the escrower and payee trade keys
    * @dev Must be in Open state
    * @param prevAmountTraded The total amount traded to the payee in the
    * payment channel before the last trade
    * @param tradeAmount The current trade amount
    * @param puzzle A hash puzzle where the solution (preimage) releases the
    * `tradeAmount` to the payee
    * @param  puzzleTimelock The time at which the `tradeAmount` can be
    * refunded back to the escrower if the puzzle solution is not posted
    */
    function postPuzzle(
        Escrow escrow,
        uint prevAmountTraded,
        uint tradeAmount,
        bytes32 puzzle,
        uint puzzleTimelock,
        bytes memory eSig,
        bytes memory pSig
    )
        public
        inState(escrow.escrowState(), EscrowState.Open)
    {
        EscrowParams memory escrowParams = escrows[address(escrow)];

        // Length of the actual message: 20 + 1 + 32 + 32 + 32 + 32
        string memory messageLength = '149';
        bytes32 sighash = keccak256(abi.encodePacked(
            SIGNATURE_PREFIX,
            messageLength,
            address(escrow),
            uint8(MessageTypeId.Puzzle),
            prevAmountTraded,
            tradeAmount,
            puzzle,
            puzzleTimelock
        ));

        require(verify(sighash, eSig) == escrowParams.escrowTrade, "Invalid escrower sig");
        require(verify(sighash, pSig) == escrowParams.payeeTrade, "Invalid payee sig");

        // Save the puzzle parameters
        emit PuzzlePosted(address(escrow), puzzle);

        postedPuzzles[address(escrow)] = PuzzleParams(
            puzzle,
            puzzleTimelock,
            sighash
        );
        escrow.setState(EscrowState.PuzzlePosted);

        // Return the previously traded funds
        escrow.sendToPayee(prevAmountTraded);
        escrow.sendToEscrower(escrowParams.escrowAmount - prevAmountTraded - tradeAmount);
    }

    /**
    * Payee solves the hash puzzle redeeming the last trade amount of funds in the escrow
    * @dev Must be in PuzzlePosted state
    * @param preimage The preimage x such that H(x) == puzzle
    */
    function solvePuzzle(
        address payable escrowAddress,
        bytes32 preimage
    )
        public
        inState(Escrow(escrowAddress).escrowState(), EscrowState.PuzzlePosted)
    {
        Escrow escrow = Escrow(escrowAddress);
        EscrowParams memory escrowParams = escrows[address(escrow)];

        PuzzleParams memory puzzleParams = postedPuzzles[address(escrow)];
        bytes32 h = keccak256(abi.encodePacked(preimage));
        require(h == puzzleParams.puzzle, "Invalid preimage");

        emit Preimage(address(escrow), preimage);
        sendRemainingToPayee(escrowAddress, escrowParams);

        emit EscrowClosed(address(escrow), EscrowCloseReason.PuzzleSolve, puzzleParams.puzzleSighash);
        escrow.closeEscrow();
    }

    /**
    * Escrower refunds the last trade amount after `puzzleTimelock` has been reached
    * @dev Must be in PuzzlePosted state
    */
    function refundPuzzle(
        address payable escrowAddress
    )
        public
        inState(Escrow(escrowAddress).escrowState(), EscrowState.PuzzlePosted)
    {
        Escrow escrow = Escrow(escrowAddress);
        EscrowParams memory escrowParams = escrows[address(escrow)];

        PuzzleParams memory puzzleParams = postedPuzzles[address(escrow)];
        require(now >= puzzleParams.puzzleTimelock, "Puzzle timelock not reached");

        sendRemainingToEscrower(escrowAddress, escrowParams);

        emit EscrowClosed(address(escrow), EscrowCloseReason.PuzzleRefund, puzzleParams.puzzleSighash);
        escrow.closeEscrow();
    }

    /** Verify a EC signature (v,r,s) on a message digest h
    * Uses EIP-191 for ethereum signed messages
    * @return retAddr The recovered address from the signature or 0 if signature is invalid
    */
    function verify(bytes32 sighash, bytes memory sig) internal pure returns(address retAddr) {
        retAddr = ECDSA.recover(sighash, sig);
    }

}