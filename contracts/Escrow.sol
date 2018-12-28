pragma solidity 0.4.25;

import "openzeppelin-solidity/contracts/token/ERC20/ERC20.sol";


/** 
* @title CWC Escrow Contract
* @dev Implementation of a CWC unidirectional escrow payment channel
* @dev Abstract contract with methods that must be implemented for either ETH
* or ERC20 tokens in derived contracts
*/
contract Escrow {

    // Events
    event PuzzlePosted();
    event EscrowClosed();

    enum EscrowState { UNFUNDED, OPEN, PUZZLE_POSTED, CLOSED }

    // Immutable State (only set once in constructor)

    // Escrower Keys
    address public escrowerTrade;
    address public escrowerReserve;
    address public escrowerRefund;

    // Payee Keys
    address public payeeTrade;
    address public payeeReserve;
    address public payeePuzzle;

    uint public escrowAmount;
    uint public escrowTimelock;

    // Mutable state

    EscrowState public escrowState;
    bytes32 public puzzle;
    uint public puzzleTimelock;

    // Modifiers
    modifier inState(EscrowState _state) {
        require(escrowState == _state, "Invalid escrow _state");
        _;
    }

    modifier afterTimelock(uint _timelock) {
        require(now >= _timelock, "Timelock not reached");
        _;
    }

    constructor(address[3] _escrowerKeys, address[3] _payeeKeys, uint _timelock) internal {
        escrowerReserve = _escrowerKeys[0];
        escrowerTrade = _escrowerKeys[1];
        escrowerRefund = _escrowerKeys[2];

        payeeReserve = _payeeKeys[0];
        payeeTrade = _payeeKeys[1];
        payeePuzzle = _payeeKeys[2];

        escrowTimelock = _timelock;
    }

    /** Cashout the escrow sending the final balances after trading
    * @dev Must be signed by both the escrower and payee trade keys
    * @dev Must be in OPEN state
    * @param _escrowerAmount The amount to send to the escrower
    * @param _payeeAmount The amount to send to the payee
    */
    function cashout(
        uint _escrowerAmount,
        uint _payeeAmount,
        uint8 _eV, bytes32 _eR, bytes32 _eS,
        uint8 _pV, bytes32 _pR, bytes32 _pS
    )
        public
        inState(EscrowState.OPEN)
    {
        // TODO: use encodePacked() instead ?
        bytes32 h = keccak256(abi.encode(
            address(this),
            _escrowerAmount,
            _payeeAmount
        ));

        // Check amounts are valid
        require(_escrowerAmount + _payeeAmount == escrowAmount);

        // Check signatures
        require(verify(h, _eV, _eR, _eS) == escrowerTrade, "Invalid escrower cashout signature");
        require(verify(h, _pV, _pR, _pS) == payeeTrade, "Invalid payee cashout signature");

        closeEscrow();
        sendToEscrower(_escrowerAmount);
        sendToPayee(_payeeAmount);
    }

    /** Allows the escrower to refund the escrow after the `escrowTimelock` has been reached
    * @dev Must be signed by the escrower refund key
    * @dev Must be in OPEN state
    * @param _escrowerAmount The amount to send to the escrower
    * @param _payeeAmount The amount to send to the payee
    */
    function refund(
        uint _escrowerAmount,
        uint _payeeAmount,
        uint8 _eV, bytes32 _eR, bytes32 _eS
    )
        public
        inState(EscrowState.OPEN)
        afterTimelock(escrowTimelock)
    {
        // TODO: use encodePacked() instead ?
        bytes32 h = keccak256(abi.encode(
            address(this),
            _escrowerAmount,
            _payeeAmount
        ));

        // Check amounts are valid
        require(_escrowerAmount + _payeeAmount == escrowAmount);

        // Check signature
        require(verify(h, _eV, _eR, _eS) == escrowerRefund, "Invalid escrower signature");

        closeEscrow();
        sendToEscrower(_escrowerAmount);
        sendToPayee(_payeeAmount);
    }

    /** Post a hash puzzle unlocks lastest trade in the escrow 
    * @dev Must be signed by both the escrower and payee trade keys
    * @dev Must be in OPEN state
    * @param _escrowerAmount The amount previously held by the escrower
    * @param _payeeAmount The amount previously traded to the payee
    * @param _tradeAmount The current trade amount
    * @param _puzzle A hash puzzle where the solution (preimage) releases the
    * `_tradeAmount` to the payee
    * @param  _puzzleTimelock The time at which the `_tradeAmount` can be
    * refunded back to the escrower if the puzzle solution is not posted
    */
    function postPuzzle(
        uint _escrowerAmount,
        uint _payeeAmount,
        uint _tradeAmount,
        bytes32 _puzzle,
        uint _puzzleTimelock,
        uint8 _eV, bytes32 _eR, bytes32 _eS,
        uint8 _pV, bytes32 _pR, bytes32 _pS
    )
        public
        inState(EscrowState.OPEN)
    {
        // TODO: use encodePacked() instead ?
        bytes32 h = keccak256(abi.encode(
            address(this),
            _escrowerAmount,
            _payeeAmount,
            _tradeAmount,
            _puzzle,
            _puzzleTimelock
        ));

        // Check amounts are valid
        require(_escrowerAmount + _payeeAmount + _tradeAmount == escrowAmount);

        // Check signatures
        require(verify(h, _eV, _eR, _eS) == escrowerTrade, "Invalid escrower signature");
        require(verify(h, _pV, _pR, _pS) == payeeTrade, "Invalid payee signature");

        // Save the puzzle parameters
        puzzle = _puzzle;
        puzzleTimelock = _puzzleTimelock;

        escrowState = EscrowState.PUZZLE_POSTED;
        emit PuzzlePosted();

        // Return the previously traded funds
        sendToEscrower(_escrowerAmount);
        sendToPayee(_payeeAmount);
    }

    /**
    * Payee solves the hash puzzle redeeming the last trade amount of funds in the escrow
    * @dev Must be in PUZZLE_POSTED state
    * @param _preimage The preimage x such that H(x) == puzzle
    */
    function solvePuzzle(bytes32 _preimage)
        public
        inState(EscrowState.PUZZLE_POSTED)
    {
        bytes32 h = keccak256(abi.encode(_preimage));
        require(h == puzzle, "Invalid preimage");

        closeEscrow();
        sendRemainingToPayee();
    }

    /**
    * Escrower refunds the last trade amount after `puzzleTimelock` has been reached
    * @dev Must be in PUZZLE_POSTED state
    */
    function refundPuzzle()
        public
        inState(EscrowState.PUZZLE_POSTED)
        afterTimelock(puzzleTimelock)
    {
        closeEscrow();
        sendRemainingToEscrower();
    }

    /** Verify a EC signature (v,r,s) on a message digest h
    * @dev TODO: remove prefix that web3.eth.sign() automatically includes
    * https://ethereum.stackexchange.com/questions/15364/ecrecover-from-geth-and-web3-eth-sign
    * @return retAddr The recovered address from the signature or 0 if signature is invalid
    */
    function verify( bytes32 _h, uint8 _v, bytes32 _r, bytes32 _s) public pure returns(address retAddr) {
        bytes memory prefix = "\x19Ethereum Signed Message:\n32";
        bytes32 prefixedHash = keccak256(abi.encodePacked(prefix, _h));
        retAddr = ecrecover(prefixedHash, _v, _r, _s);
    }

    /**
    * Moves escrow state to CLOSED and emits an event log that the escrow has been closed
    */
    function closeEscrow() internal {
        escrowState = EscrowState.CLOSED;
        emit EscrowClosed();
    }

    /**
    * Abstract methods that must be implemented by derived classes
    */
    function sendToEscrower(uint _amt) internal;
    function sendRemainingToEscrower() internal;
    function sendToPayee(uint _amt) internal;
    function sendRemainingToPayee() internal;
}


/** 
* @title CWC Escrow Contract backed by ETH
* @dev Implementation of a CWC unidirectional escrow payment channel using ETH directly
* @dev Escrow starts in the OPEN state because it is funded in the constructor
* by sending `escrowAmount` of ETH with the transaction
*/
contract EthEscrow is Escrow {

    constructor(address[3] _escrowerKeys, address[3] _payeeKeys, uint _timelock) public payable 
    Escrow(_escrowerKeys, _payeeKeys, _timelock) {
        escrowAmount = msg.value;
        escrowState = EscrowState.OPEN;
    }

    // TODO: use withdrawal pattern instead of transfer so malicious contract cant trap funds in escrow
    // see https://solidity.readthedocs.io/en/develop/common-patterns.html#withdrawal-from-contracts
    function sendToEscrower(uint _amt) internal {
        escrowerReserve.transfer(_amt);
    }

    function sendRemainingToEscrower() internal {
        escrowerReserve.transfer(address(this).balance);
    }

    function sendToPayee(uint _amt) internal {
        payeeReserve.transfer(_amt);
    }

    function sendRemainingToPayee() internal {
        payeeReserve.transfer(address(this).balance);
    }
}


/** 
* @title CWC Escrow Contract backed by a ERC20 token
* @dev Implementation of a CWC unidirectional escrow payment channel using an arbitrary ERC20 token
* @dev Escrow starts in the UNFUNDED state and only moves to OPEN once the
* `fundEscrow` function is called which also transfers `escrowAmount` of tokens
* into this contract from a target address that has approved the transfer
*/
contract Erc20Escrow is Escrow {

    ERC20 public token;

    constructor(address _tknAddr, uint _tknAmt, address[3] _escrowerKeys, address[3] _payeeKeys, uint _timelock) public
    Escrow(_escrowerKeys, _payeeKeys, _timelock) {
        escrowAmount = _tknAmt;

        // Validate the token address implements the ERC20 interface
        token = ERC20(_tknAddr);

        // Start in UNFUNDED state until the fundEscrow function is called
        escrowState = EscrowState.UNFUNDED;
    }

    /**
    * Attempts to transfer at least escrowAmount into this contract
    * @dev Will fail unless the _from address has approved this contract to
    * transfer `escrowAmount` using the `approve` method of the token contract
    * @param _from The address to transfer the tokens from
    */
    function fundEscrow(address _from) public inState(EscrowState.UNFUNDED) {
        require(token.transferFrom(_from, address(this), escrowAmount));
        escrowState = EscrowState.OPEN;
    }

    function sendToEscrower(uint _amt) internal {
        token.transfer(escrowerReserve, _amt);
    }

    function sendRemainingToEscrower() internal {
        token.transfer(escrowerReserve, token.balanceOf(address(this)));
    }

    function sendToPayee(uint _amt) internal {
        token.transfer(payeeReserve, _amt);
    }

    function sendRemainingToPayee() internal {
        token.transfer(payeeReserve, token.balanceOf(address(this)));
    }
}