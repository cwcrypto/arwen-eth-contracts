pragma solidity ^0.5.0;

import "./Escrow.sol";

import "openzeppelin-solidity/contracts/math/SafeMath.sol";
import "openzeppelin-solidity/contracts/cryptography/ECDSA.sol";


/**
* Central contract containing the business logic for interacting with and
* managing the state of Arwen unidirectional payment channels
* @dev Escrows contracts are created and linked to this library from the
* EscrowFactory contract
*/
contract EscrowLibrary {

    using SafeMath for uint;

    string constant SIGNATURE_PREFIX = '\x19Ethereum Signed Message:\n';
    uint constant FORCE_REFUND_TIME = 2 days;

    /**
    * Escrow State Machine
    * @param None Preliminary state of an escrow before it has been created.
    * @param Unfunded Initial state of the escrow once created. The escrow can only
    * transition to the Open state once it has been funded with required escrow
    * amount and openEscrow method is called.
    * @param Open From this state the escrow can transition to Closed state
    * via the cashout or refund methods or it can transition to PuzzlePosted state
    * via the postPuzzle method.
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
    * Unique ID for each different type of signed message in the protocol
    */
    enum MessageTypeId {
        None,
        Cashout,
        Puzzle,
        Refund
    }

    /**
    * Possible reasons the escrow can become closed
    */
    enum EscrowCloseReason {
        Refund,
        PuzzleRefund,
        PuzzleSolve,
        Cashout,
        ForceRefund
    }

    event EscrowOpened(address indexed escrow);
    event EscrowFunded(address indexed escrow, uint amountFunded);
    event PuzzlePosted(address indexed escrow, bytes32 puzzleSighash);
    event Preimage(address indexed escrow, bytes32 preimage, bytes32 puzzleSighash);
    event EscrowClosed(address indexed escrow, EscrowCloseReason reason, bytes32 closingSighash);
    event FundsTransferred(address indexed escrow, address reserveAddress);

    struct EscrowParams {
        // The amount expected to be funded by the escrower to open the payment channel
        uint escrowAmount;

        // Expiration time of the escrow when it can refunded by the escrower
        uint escrowTimelock;

        // Escrower's pub keys
        address payable escrowerReserve;
        address escrowerTrade;
        address escrowerRefund;

        // Payee's pub keys
        address payable payeeReserve;
        address payeeTrade;

        // Current state of the escrow
        EscrowState escrowState;

        // Internal payee/escrower balances within the payment channel
        uint escrowerBalance;
        uint payeeBalance;
    }

    /**
    * Represents a trade in the payment channel that can be executed
    * on-chain by the payee by revealing a hash preimage
    */
    struct PuzzleParams {
        // The amount of coins in this trade
        uint tradeAmount;

        // A hash output or "puzzle" which can be "solved" by revealing the preimage
        bytes32 puzzle;

        // The expiration time of the puzzle when the trade can be refunded by the escrower
        uint puzzleTimelock;

        // The signature hash of the `postPuzzle` message
        bytes32 puzzleSighash;
    }

    // The EscrowFactory contract that deployed this library
    address public escrowFactory;

    // Mapping of escrow address to EscrowParams
    mapping(address => EscrowParams) public escrows;

    // Mapping of escrow address to PuzzleParams
    // Only a single puzzle can be posted for a given escrow
    mapping(address => PuzzleParams) public puzzles;

    constructor() public {
        escrowFactory = msg.sender;
    }

    modifier onlyFactory() {
        require(msg.sender == escrowFactory, "Can only be called by escrow factory");
        _;
    }

    /**
    * Add a new escrow that is controlled by the library
    * @dev Only callable by the factory which should have already deployed the
    * escrow at the provided address
    */
    function newEscrow(
        address escrow,
        uint escrowAmount,
        uint timelock,
        address payable escrowerReserve,
        address escrowerTrade,
        address escrowerRefund,
        address payable payeeReserve,
        address payeeTrade
    )
        public
        onlyFactory
    {
        require(escrows[escrow].escrowState == EscrowState.None, "Escrow already exists");
        require(escrowAmount > 0, "Escrow amount too low");

        uint escrowerStartingBalance = 0;
        uint payeeStartingBalance = 0;

        escrows[escrow] = EscrowParams(
            escrowAmount,
            timelock,
            escrowerReserve,
            escrowerTrade,
            escrowerRefund,
            payeeReserve,
            payeeTrade,
            EscrowState.Unfunded,
            escrowerStartingBalance,
            payeeStartingBalance
        );
    }

    /**
    * Emits an event with the current balance of the escrow
    * @dev Can be used by the EthEscrow contract's payable fallback to
    * automatically emit an event when an escrow is funded
    */
    function checkFunded(address escrowAddress) public {
        EscrowParams storage escrowParams = escrows[escrowAddress];

        require(msg.sender == escrowAddress, "Only callable by the Escrow contract");
        require(escrowParams.escrowState == EscrowState.Unfunded, "Escrow must be in state Unfunded");

        emit EscrowFunded(escrowAddress, Escrow(escrowAddress).balance());
    }

    /**
    * Moves the escrow to the open state if it has been funded
    * @dev Will send back any additional collateral above the `escrowAmount`
    * back to the escrower before opening
    */
    function openEscrow(address escrowAddress) public {
        EscrowParams storage escrowParams = escrows[escrowAddress];
        require(escrowParams.escrowState == EscrowState.Unfunded, "Escrow must be in state Unfunded");
        
        Escrow escrow = Escrow(escrowAddress);
        uint escrowAmount = escrowParams.escrowAmount;
        uint escrowBalance = escrow.balance();

        // Check the escrow is funded for at least escrowAmount
        require(escrowBalance >= escrowAmount, "Escrow not funded");

        escrowParams.escrowState = EscrowState.Open;
        emit EscrowOpened(escrowAddress);

        // If over-funded return any excess funds back to the escrower
        if(escrowBalance > escrowAmount) {
           escrow.send(escrowParams.escrowerReserve, escrowBalance.sub(escrowAmount));
        }
    }

    /**
    * Cashout the escrow with the final balances after trading
    * @dev Must be signed by both the escrower and payee trade keys
    * @dev Must be in Open state
    * @param amountTraded The total amount traded to the payee
    */
    function cashout(
        address escrowAddress,
        uint amountTraded,
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
            amountTraded
        ));

        // Check signatures
        require(verify(sighash, eSig) == escrowParams.escrowerTrade, "Invalid escrower cashout sig");
        require(verify(sighash, pSig) == escrowParams.payeeTrade, "Invalid payee cashout sig");

        escrowParams.payeeBalance = amountTraded;
        escrowParams.escrowerBalance = escrowParams.escrowAmount.sub(amountTraded);
        escrowParams.escrowState = EscrowState.Closed;

        if(escrowParams.escrowerBalance > 0) sendEscrower(escrowAddress, escrowParams);
        if(escrowParams.payeeBalance > 0) sendPayee(escrowAddress, escrowParams);

        emit EscrowClosed(escrowAddress, EscrowCloseReason.Cashout, sighash);
    }

    /**
    * Allows the escrower to refund the escrow after the escrow expires
    * @dev This is a signed refund because it allows the refunder to
    * specify the amount traded in the escrow. This is useful for the escrower to
    * benevolently close the escrow with the final balances despite the other
    * party being offline
    * @dev Must be signed by the escrower refund key
    * @dev Must be in Open state
    * @param amountTraded The total amount traded to the payee
    */
    function refund(address escrowAddress, uint amountTraded, bytes memory eSig) public {
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
            amountTraded
        ));

        // Check signature
        require(verify(sighash, eSig) == escrowParams.escrowerRefund, "Invalid escrower sig");

        escrowParams.payeeBalance = amountTraded;
        escrowParams.escrowerBalance = escrowParams.escrowAmount.sub(amountTraded);
        escrowParams.escrowState = EscrowState.Closed;

        if(escrowParams.escrowerBalance > 0) sendEscrower(escrowAddress, escrowParams);
        if(escrowParams.payeeBalance > 0) sendPayee(escrowAddress, escrowParams);

        emit EscrowClosed(escrowAddress, EscrowCloseReason.Refund, sighash);
    }

    /**
    * Allows anyone to refund the escrow back to the escrower without a
    * signature after escrowTimelock + FORCE_REFUND_TIME
    * @dev This method can be used in the event the escrower's keys are lost
    * or if the escrower remains offline for an extended period of time
    */
    function forceRefund(address escrowAddress) public {
        EscrowParams storage escrowParams = escrows[escrowAddress];
        require(escrowParams.escrowState == EscrowState.Open, "Escrow must be in state Open");
        require(now >= escrowParams.escrowTimelock + FORCE_REFUND_TIME, "Escrow force refund timelock not reached");

        escrowParams.escrowerBalance = Escrow(escrowAddress).balance();
        escrowParams.escrowState = EscrowState.Closed;

        if(escrowParams.escrowerBalance > 0) sendEscrower(escrowAddress, escrowParams);

        // Use 0x0 as the closing sighash because there is no signature required
        emit EscrowClosed(escrowAddress, EscrowCloseReason.ForceRefund, 0x0);
    }

    /**
    * Post a hash puzzle unlocks lastest trade in the escrow
    * @dev Must be signed by both the escrower and payee trade keys
    * @dev Must be in Open state
    * @param prevAmountTraded The total amount traded to the payee in the
    * payment channel before the last trade
    * @param tradeAmount The last trade amount
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

        require(verify(sighash, eSig) == escrowParams.escrowerTrade, "Invalid escrower sig");
        require(verify(sighash, pSig) == escrowParams.payeeTrade, "Invalid payee sig");

        puzzles[escrowAddress] = PuzzleParams(
            tradeAmount,
            puzzle,
            puzzleTimelock,
            sighash
        );

        escrowParams.escrowState = EscrowState.PuzzlePosted;
        escrowParams.payeeBalance = prevAmountTraded;
        escrowParams.escrowerBalance = escrowParams.escrowAmount.sub(prevAmountTraded).sub(tradeAmount);

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

        PuzzleParams memory puzzleParams = puzzles[escrowAddress];
        bytes32 h = sha256(abi.encodePacked(preimage));
        require(h == puzzleParams.puzzle, "Invalid preimage");
        emit Preimage(escrowAddress, preimage, puzzleParams.puzzleSighash);

        escrowParams.payeeBalance = escrowParams.payeeBalance.add(puzzleParams.tradeAmount);
        escrowParams.escrowState = EscrowState.Closed;

        emit EscrowClosed(escrowAddress, EscrowCloseReason.PuzzleSolve, puzzleParams.puzzleSighash);
    }

    /**
    * Escrower refunds the last trade amount after `puzzleTimelock` has been reached
    * @dev Must be in PuzzlePosted state
    */
    function refundPuzzle(address escrowAddress) public {
        EscrowParams storage escrowParams = escrows[escrowAddress];
        require(escrowParams.escrowState == EscrowState.PuzzlePosted, "Escrow must be in state PuzzlePosted");

        PuzzleParams memory puzzleParams = puzzles[escrowAddress];
        require(now >= puzzleParams.puzzleTimelock, "Puzzle timelock not reached");
        
        escrowParams.escrowerBalance = escrowParams.escrowerBalance.add(puzzleParams.tradeAmount);
        escrowParams.escrowState = EscrowState.Closed;

        emit EscrowClosed(escrowAddress, EscrowCloseReason.PuzzleRefund, puzzleParams.puzzleSighash);
    }

    function withdraw(address escrowAddress, bool escrower) public {
        EscrowParams storage escrowParams = escrows[escrowAddress];

        if(escrower) {
            require(escrowParams.escrowerBalance > 0, "escrower balance is 0");
            sendEscrower(escrowAddress, escrowParams);
        } else {
            require(escrowParams.payeeBalance > 0, "payee balance is 0");
            sendPayee(escrowAddress, escrowParams);
        }
    }

    function sendEscrower(address escrowAddress, EscrowParams storage escrowParams) internal {
        Escrow escrow = Escrow(escrowAddress);

        uint amountToSend = escrowParams.escrowerBalance;
        escrowParams.escrowerBalance = 0;
        require(escrow.send(escrowParams.escrowerReserve, amountToSend), "escrower send failure");

        emit FundsTransferred(escrowAddress, escrowParams.escrowerReserve);
    }

    function sendPayee(address escrowAddress, EscrowParams storage escrowParams) internal {
        Escrow escrow = Escrow(escrowAddress);

        uint amountToSend = escrowParams.payeeBalance;
        escrowParams.payeeBalance = 0;
        require(escrow.send(escrowParams.payeeReserve, amountToSend), "payee send failure");

        emit FundsTransferred(escrowAddress, escrowParams.payeeReserve);
    }

    /**
    * Verify a EC signature (v,r,s) on a message digest h
    * @return retAddr The recovered address from the signature or 0 if signature is invalid
    */
    function verify(bytes32 sighash, bytes memory sig) internal pure returns(address retAddr) {
        retAddr = ECDSA.recover(sighash, sig);
    }
}
