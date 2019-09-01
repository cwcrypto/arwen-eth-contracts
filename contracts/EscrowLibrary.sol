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

    struct PuzzleParams {
        bytes32 puzzle;
        uint puzzleTimelock;
        bytes32 puzzleSighash;
    }

    mapping(address => PuzzleParams) postedPuzzles;

    /**
    * @dev Restricts method to only be callable when a given time has been
    * reached
    */
    modifier afterTimelock(uint timelock) {
        require(now >= timelock, "Timelock not reached");
        _;
    }

    function checkFunded(EthEscrow escrow) public {
        emit EscrowFunded(address(escrow), address(escrow).balance);
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
        uint escrowAmount = escrow.escrowAmount();
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
        escrow.open(from);
        emit EscrowOpened(address(escrow));
    }

    /** Cashout the escrow sending the final balances after trading
    * @dev Must be signed by both the escrower and payee trade keys
    * @dev Must be in Open state
    * @param prevAmountTraded The total amount traded to the payee in the
    * payment channel
    */
    function cashout(
        Escrow escrow,
        uint prevAmountTraded,
        bytes memory eSig,
        bytes memory pSig
    )
        public
        inState(escrow.escrowState(), EscrowState.Open)
    {
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
        require(verify(sighash, eSig) == escrow.escrowTrade(), "Invalid escrower cashout sig");
        require(verify(sighash, pSig) == escrow.payeeTrade(), "Invalid payee cashout sig");

        escrow.sendToPayee(prevAmountTraded);
        escrow.sendRemainingToEscrower();

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
        Escrow escrow,
        uint prevAmountTraded,
        bytes memory eSig
    )
        public
        inState(escrow.escrowState(), EscrowState.Open)
        afterTimelock(escrow.escrowTimelock())
    {
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
        require(verify(sighash, eSig) == escrow.escrowRefund(), "Invalid escrower sig");

        escrow.sendToPayee(prevAmountTraded);
        escrow.sendRemainingToEscrower();

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

        require(verify(sighash, eSig) == escrow.escrowTrade(), "Invalid escrower sig");
        require(verify(sighash, pSig) == escrow.payeeTrade(), "Invalid payee sig");

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
        escrow.sendToEscrower(escrow.escrowAmount() - prevAmountTraded - tradeAmount);
    }

    /**
    * Payee solves the hash puzzle redeeming the last trade amount of funds in the escrow
    * @dev Must be in PuzzlePosted state
    * @param preimage The preimage x such that H(x) == puzzle
    */
    function solvePuzzle(
        Escrow escrow,
        bytes32 preimage
    )
        public
        inState(escrow.escrowState(), EscrowState.PuzzlePosted)
    {
        PuzzleParams memory puzzleParams = postedPuzzles[address(escrow)];
        bytes32 h = keccak256(abi.encodePacked(preimage));
        require(h == puzzleParams.puzzle, "Invalid preimage");

        emit Preimage(address(escrow), preimage);
        escrow.sendRemainingToPayee();

        emit EscrowClosed(address(escrow), EscrowCloseReason.PuzzleSolve, puzzleParams.puzzleSighash);
        escrow.closeEscrow();
    }

    /**
    * Escrower refunds the last trade amount after `puzzleTimelock` has been reached
    * @dev Must be in PuzzlePosted state
    */
    function refundPuzzle(
        Escrow escrow
    )
        public
        inState(escrow.escrowState(), EscrowState.PuzzlePosted)
    {
        PuzzleParams memory puzzleParams = postedPuzzles[address(escrow)];
        require(now >= puzzleParams.puzzleTimelock, "Puzzle timelock not reached");

        escrow.sendRemainingToEscrower();

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