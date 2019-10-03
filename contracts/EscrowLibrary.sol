pragma solidity ^0.5.0;

import "./Escrow.sol";
import "openzeppelin-solidity/contracts/cryptography/ECDSA.sol";


contract EscrowLibrary {

    string constant SIGNATURE_PREFIX = '\x19Ethereum Signed Message:\n';
    uint constant FORCE_REFUND_TIME = 2 days;

    enum MessageTypeId {
        None,
        Cashout,
        Puzzle,
        Refund
    }

    /**
    * @title Escrow State Machine
    * @param None Preliminary state of an escrow before it has been created.
    * @param Unfunded Initial state of the escrow once created. The escrow can only
    * transition to the Open state once it has been funded with required escrow
    * amount and openEscrow method is called.
    * @param Open From this state the escrow can transition to Closed state
    * (self-destructed) via the cashout or refund methods or it can
    * transition to PuzzlePosted state via the postPuzzle method.
    * @param PuzzlePosted From this state the escrow can only transition to
    * closed via the solve or puzzleRefund methods
    * @param Closed The final sink state of the escrow
    */
    enum EscrowState {
        None,
        Unfunded,
        Open,
        PuzzlePosted,
        Closed
    }

    /**
    * @dev Possible reasons the escrow can become closed
    */
    enum EscrowCloseReason {
        Refund,
        PuzzleRefund,
        PuzzleSolve,
        Cashout,
        ForceRefund
    }

    // Events
    event EscrowOpened(address indexed escrow);
    event EscrowFunded(address indexed escrow, uint amountFunded);
    event PuzzlePosted(address indexed escrow, bytes32 puzzleSighash);
    event Preimage(address indexed escrow, bytes32 preimage, bytes32 puzzleSighash);
    event EscrowClosed(address indexed escrow, EscrowCloseReason reason, bytes32 sighash);

    struct EscrowParams {
        uint escrowAmount;
        uint escrowTimelock;
        address payable escrowReserve;
        address escrowTrade;
        address escrowRefund;
        address payable payeeReserve;
        address payeeTrade;
        EscrowState escrowState;
        uint escrowerBalance;
        uint payeeBalance;
    }

    struct PuzzleParams {
        uint tradeAmount;
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

    function checkFunded(address escrowAddress) public {
        EscrowParams storage escrowParams = escrows[escrowAddress];
        require(escrowParams.escrowState == EscrowState.Unfunded, "Escrow must be in state unfunded");
        emit EscrowFunded(escrowAddress, Escrow(escrowAddress).balance());
    }

    function newEscrow(
        address escrow,
        uint escrowAmount,
        uint timelock,
        address payable escrowReserve,
        address escrowTrade,
        address escrowRefund,
        address payable payeeReserve,
        address payeeTrade
    )
        public
        onlyFactory
    {
        
        EscrowParams storage checkEscrow = escrows[address(escrow)];

        require(checkEscrow.escrowState == EscrowState.None, "Escrow already exists");
        require(escrowAmount > 0, "Escrow amount too low");

        escrows[address(escrow)] = EscrowParams(
            escrowAmount,
            timelock,
            escrowReserve,
            escrowTrade,
            escrowRefund,
            payeeReserve,
            payeeTrade,
            EscrowState.Unfunded,
            0,
            0
        );
    }

    function openEscrow(address escrowAddress) public {
        EscrowParams storage escrowParams = escrows[escrowAddress];
        require(escrowParams.escrowState == EscrowState.Unfunded, "Escrow must be in state Unfunded");
        
        Escrow escrow = Escrow(escrowAddress);
        uint escrowAmount = escrowParams.escrowAmount;
        uint escrowBalance = escrow.balance();

        require(escrowBalance >= escrowAmount, "Escrow not funded");
        if(escrowBalance > escrowAmount) {
           escrow.send(escrowParams.escrowReserve, escrowBalance - escrowAmount);
        }

        escrowParams.escrowState = EscrowState.Open;
        emit EscrowOpened(escrowAddress);
    }

    /** Cashout the escrow sending the final balances after trading
    * @dev Must be signed by both the escrower and payee trade keys
    * @dev Must be in Open state
    * @param prevAmountTraded The total amount traded to the payee in the
    * payment channel
    */
    function cashout(
        address escrowAddress,
        uint prevAmountTraded,
        bytes memory eSig,
        bytes memory pSig
    )
        public
    {
        EscrowParams storage escrowParams = escrows[escrowAddress];
        require(escrowParams.escrowState == EscrowState.Open, "Escrow must be in state Open");

        // Length of the actual message: 20 + 1 + 32
        string memory messageLength = '53';
        bytes32 sighash = keccak256(abi.encodePacked(
            SIGNATURE_PREFIX,
            messageLength,
            escrowAddress,
            uint8(MessageTypeId.Cashout),
            prevAmountTraded
        ));

        // Check signatures
        require(verify(sighash, eSig) == escrowParams.escrowTrade, "Invalid escrower cashout sig");
        require(verify(sighash, pSig) == escrowParams.payeeTrade, "Invalid payee cashout sig");

        escrowParams.payeeBalance += prevAmountTraded;
        escrowParams.escrowerBalance += escrowParams.escrowAmount - prevAmountTraded;
        closeEscrow(escrowAddress, escrowParams);

        emit EscrowClosed(escrowAddress, EscrowCloseReason.Refund, sighash);
    }

    /**
    * Allows the escrower to refund the escrow after the `escrowTimelock` has
    * been reached. This is a signed refund because it allows the refunder to
    * specify the amount traded in the escrow. This is useful for the escrower to
    * benevolently close the escrow with the final balances despite the other
    * party being offline (even though the escrower could take the full escrow
    * amount in this case).
    * @dev Must be signed by the escrower refund key
    * @dev Must be in Open state
    * @param prevAmountTraded The total amount traded to the payee in the
    * payment channel
    */
    function refund(address escrowAddress, uint prevAmountTraded, bytes memory eSig) public {
        EscrowParams storage escrowParams = escrows[escrowAddress];
        require(escrowParams.escrowState == EscrowState.Open, "Escrow must be in state Open");
        require(now >= escrowParams.escrowTimelock, "Escrow timelock not reached");
        
        // Length of the actual message: 20 + 1 + 32
        string memory messageLength = '53';
        bytes32 sighash = keccak256(abi.encodePacked(
            SIGNATURE_PREFIX,
            messageLength,
            escrowAddress,
            uint8(MessageTypeId.Refund),
            prevAmountTraded
        ));

        // Check signature
        require(verify(sighash, eSig) == escrowParams.escrowRefund, "Invalid escrower sig");

        escrowParams.payeeBalance += prevAmountTraded;
        escrowParams.escrowerBalance += escrowParams.escrowAmount - prevAmountTraded;
        closeEscrow(escrowAddress, escrowParams);

        emit EscrowClosed(escrowAddress, EscrowCloseReason.Refund, sighash);
    }

    /**
    * @notice Force refunds escrow funds in the event the escrower's keys are
    * lost or if the escrower remains offline for an extended period of time
    */
    function forceRefund(address escrowAddress) public {
        EscrowParams storage escrowParams = escrows[escrowAddress];
        require(escrowParams.escrowState == EscrowState.Open, "Escrow must be in state Open");
        require(now >= escrowParams.escrowTimelock + FORCE_REFUND_TIME, "Escrow force refund timelock not reached");

        escrowParams.escrowerBalance = Escrow(escrowAddress).balance();
        closeEscrow(escrowAddress, escrowParams);

        // Use 0x0 as the closing sighash because there is no signature required
        emit EscrowClosed(escrowAddress, EscrowCloseReason.ForceRefund, 0x0);
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
        address escrowAddress,
        uint prevAmountTraded,
        uint tradeAmount,
        bytes32 puzzle,
        uint puzzleTimelock,
        bytes memory eSig,
        bytes memory pSig
    )
        public
    {
        EscrowParams storage escrowParams = escrows[escrowAddress];
        require(escrowParams.escrowState == EscrowState.Open, "Escrow must be in state Open");

        // Length of the actual message: 20 + 1 + 32 + 32 + 32 + 32
        string memory messageLength = '149';
        bytes32 sighash = keccak256(abi.encodePacked(
            SIGNATURE_PREFIX,
            messageLength,
            escrowAddress,
            uint8(MessageTypeId.Puzzle),
            prevAmountTraded,
            tradeAmount,
            puzzle,
            puzzleTimelock
        ));

        require(verify(sighash, eSig) == escrowParams.escrowTrade, "Invalid escrower sig");
        require(verify(sighash, pSig) == escrowParams.payeeTrade, "Invalid payee sig");

        // Save the puzzle parameters
        postedPuzzles[escrowAddress] = PuzzleParams(
            tradeAmount,
            puzzle,
            puzzleTimelock,
            sighash
        );

        escrowParams.escrowState = EscrowState.PuzzlePosted;
        escrowParams.payeeBalance += prevAmountTraded;
        escrowParams.escrowerBalance += escrowParams.escrowAmount - prevAmountTraded - tradeAmount;

        emit PuzzlePosted(escrowAddress, sighash);
    }

    /**
    * Payee solves the hash puzzle redeeming the last trade amount of funds in the escrow
    * @dev Must be in PuzzlePosted state
    * @param preimage The preimage x such that H(x) == puzzle
    */
    function solvePuzzle(address escrowAddress, bytes32 preimage) public {
        EscrowParams storage escrowParams = escrows[escrowAddress];
        require(escrowParams.escrowState == EscrowState.PuzzlePosted, "Escrow must be in state PuzzlePosted");

        PuzzleParams memory puzzleParams = postedPuzzles[escrowAddress];
        bytes32 h = sha256(abi.encodePacked(preimage));
        require(h == puzzleParams.puzzle, "Invalid preimage");
        emit Preimage(escrowAddress, preimage, puzzleParams.puzzleSighash);

        escrowParams.payeeBalance += puzzleParams.tradeAmount;
        closeEscrow(escrowAddress, escrowParams);

        emit EscrowClosed(escrowAddress, EscrowCloseReason.PuzzleSolve, puzzleParams.puzzleSighash);
    }

    /**
    * Escrower refunds the last trade amount after `puzzleTimelock` has been reached
    * @dev Must be in PuzzlePosted state
    */
    function refundPuzzle(address escrowAddress) public {
        EscrowParams storage escrowParams = escrows[escrowAddress];
        require(escrowParams.escrowState == EscrowState.PuzzlePosted, "Escrow must be in state PuzzlePosted");

        PuzzleParams memory puzzleParams = postedPuzzles[escrowAddress];
        require(now >= puzzleParams.puzzleTimelock, "Puzzle timelock not reached");
        
        escrowParams.escrowerBalance += puzzleParams.tradeAmount;
        closeEscrow(escrowAddress, escrowParams);

        emit EscrowClosed(escrowAddress, EscrowCloseReason.PuzzleRefund, puzzleParams.puzzleSighash);
    }

    /** Verify a EC signature (v,r,s) on a message digest h
    * Uses EIP-191 for ethereum signed messages
    * @return retAddr The recovered address from the signature or 0 if signature is invalid
    */
    function verify(bytes32 sighash, bytes memory sig) internal pure returns(address retAddr) {
        retAddr = ECDSA.recover(sighash, sig);
    }

    function closeEscrow(address escrowAddress, EscrowParams memory escrowParams) internal {
        escrowParams.escrowState = EscrowState.Closed;

        Escrow escrow = Escrow(escrowAddress);
        escrow.send(escrowParams.payeeReserve, escrowParams.payeeBalance);
        escrow.send(escrowParams.escrowReserve, escrowParams.escrowerBalance);
    }
}