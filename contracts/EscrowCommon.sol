pragma solidity ^0.5.0;


/**
* @title EscrowCommon 
* @dev Contains enums and modifiers shared by both the escrow and escrow library
* contract
*/
contract EscrowCommon {

    /**
    * @title Escrow State Machine
    * @param Unfunded Initial state of the escrow. The escrow can only
    * transition to the Open state once it has been funded with required escrow
    * amount and openEscrow method is called.
    * @param Open From this state the escrow can transition to Closed state
    * (self-destructed) via the cashout or refund methods or it can
    * transition to PuzzlePosted state via the postPuzzle method.
    * @param PuzzlePosted From this state the escrow can only transition to
    * closed via the solve or puzzleRefund methods 
    */
    enum EscrowState {
        Unfunded,
        Open,
        PuzzlePosted
    }

    /**
    * @dev Restricts method to only be callable when the escrow is in a
    * particular state of the Escrow State Machine 
    */
    modifier inState(EscrowState _currState, EscrowState _requiredState) {
        require(_currState == _requiredState, "Invalid escrow state");
        _;
    }
}