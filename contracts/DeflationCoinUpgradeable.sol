// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title DeflationCoinUpgradeable
 * @dev This contract demonstrates a deflationary token model with dynamic burn,
 *      optional staking with multiple years, daily unlock logic, referral rewards,
 *      and a mechanism to distribute dividends.
 */
contract DeflationCoinUpgradeable is IERC20, AccessControl {
    // Initialization flag to prevent multiple calls to initialize().
    bool private _initialized;

    /**
     * @dev Structure to store partial balances used to calculate
     *      deflation over time (daily-based burn).
     * 
     * amount    - the amount of tokens in this portion
     * timestamp - the timestamp when this portion was created
     */
    struct BalancePortion {
        uint256 amount;
        uint256 timestamp;
    }

    /**
     * @dev Staking position structure, describing each user's staking deposit and related info.
     *
     * initialAmount    - the original amount of tokens staked
     * amount           - the current staked amount (including any additions or subtractions)
     * finishedAmount   - the locked amount that can be gradually unlocked (smoothUnlock) after the staking term
     * startTime        - the starting block timestamp of this stake
     * year             - the chosen staking period in years (integer from 1 to 12)
     * lastClaimed      - stores the last "year-month" (see getYearMonth) for which dividends/unstaking were claimed
     * claimedStaking   - how many tokens have already been withdrawn from the staking principal in the current period
     * claimedDividends - how many tokens have already been withdrawn from dividends in the current period
     */
    struct StakePosition {
        uint256 initialAmount;
        uint256 amount;
        uint256 finishedAmount;
        uint256 startTime;
        uint256 year;
        uint256 lastClaimed;
        uint256 claimedStaking;
        uint256 claimedDividends;
    }

    // Basic token data
    string private _name;
    string private _symbol;

    // Mapping of allowances (owner => spender => amount).
    mapping(address => mapping(address => uint256)) private _allowances;
    // Mapping of raw (non-deflation-adjusted) balances for each address.
    mapping(address => uint256) public _balances;
    // Mapping of BalancePortions per address, used to compute daily-based burn.
    mapping(address => BalancePortion[]) private _balancePortions;
    // Mapping to store the current “start index” of the portions array for each address, 
    // indicating which portions have been fully consumed (zeroed out).
    mapping(address => uint256) private _balancePortionsStartIndex;
    // Mapping of staking positions for each address.
    mapping(address => StakePosition[]) private stakes;
     // Mapping of addresses exempted from burning logic.
    mapping(address => bool) private exemptFromBurn; 
    // Referral relationships: for each address, who is their referral address.
    mapping(address => address) private referralWallets;

    // Special pools: dividend, marketing, and technical.
    address public dividendPool;
    address public marketingPool;
    address public technicalPool;

    // Token supply and variables used for dividend calculations.
    uint256 private _totalSupply;
    uint256 private _betaIndicator;
    uint256 private _betaUpdate;
    uint256 private _poolSnapshot;
    uint256 private _betaPoDIndicator;
    // Flag indicating whether dividends are active or process of recalculating is running.
    bool public _isDividendsActive;

    // Constants for time calculations and max supply.
    uint256 private constant SECONDS_IN_YEAR = 365 * 24 * 60 * 60; 
    uint256 private constant MAX_TOTAL_SUPPLY = 20999999 * 10 ** 18; 

    // dailyReductions array: used to reduce portions day by day.
    uint256[] private dailyReductions;
    // xMultipliers array for 1..12-year staking multipliers.
    uint256[] private xMultipliers;

    // Events
    event TokensBurned(address indexed from, uint256 amount);
    event TokensStaked(address indexed staker, uint256 amount, uint256 year);
    event ExemptionUpdated(address indexed account, bool isExempt);
    event DividendsClaimed(address indexed account, uint256 amount);
    event SmoothUnlocked(address indexed account, uint256 amount);
    event ReferralWalletUpdated(address indexed account, address indexed referralWallet);
    
    // Roles
    bytes32 private constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 private constant TECHNICAL_ROLE = keccak256("TECHNICAL_ROLE");

    // Pancake V3 Pool address
    address private constant PANCAKE_V3_POOL = 0x0ebb62D2dF2DdC8bAA0903E0C76c05F638bb8F95;

    // Pancake V3 Router address
    address private constant PANCAKE_V3_ROUTER = 0x1b81D678ffb9C0263b24A97847620C99d213eB14;

    /// @notice Initialize function, calls once 
    function initialize() public {
        require(!_initialized);
        _initialized = true;
        _name = "DeflationCoin";
        _symbol = "DEF";
        _totalSupply = 0;
        _betaIndicator = 0;
        _betaPoDIndicator = 0;
        _betaUpdate = 0;
        _poolSnapshot = 0;
        _isDividendsActive = false;

        // dailyReductions array config
        dailyReductions = [99, 97, 93, 85, 71, 48, 17, 0];
        // xMultipliers for staking durations from 1 to 12 years
        xMultipliers = [1, 2, 3, 4, 5, 6, 7, 10, 12, 14, 16, 20];

        // Set up roles: default admin, admin, and technical.
        _grantRole(DEFAULT_ADMIN_ROLE, _msgSender());
        _grantRole(ADMIN_ROLE, _msgSender());
        _grantRole(TECHNICAL_ROLE, _msgSender());

        // Exempt the contract owner from burn logic
        exemptFromBurn[_msgSender()] = true;

        // Mint the maximum supply to the deployer (for demonstration).
        _update(address(0), _msgSender(), MAX_TOTAL_SUPPLY);
    }

    /**
     * @dev Returns the total supply (sum of all minted tokens minus burned ones).
     */
    function totalSupply() public view returns (uint256) {
        return _totalSupply;
    }

    /**
     * @dev Returns the name of this token, e.g. "DeflationCoin".
     */
    function name() public view returns (string memory) {
        return _name;
    }

    /**
     * @dev Returns the token symbol, e.g. "DEF".
     */
    function symbol() public view virtual returns (string memory) {
        return _symbol;
    }

    /**
     * @dev Returns decimals (commonly 18 for ERC20).
     */
    function decimals() public view virtual returns (uint8) {
        return 18;
    }

    /**
     * @dev Returns how many tokens `spender` can still spend on behalf of `owner` via transferFrom.
     */
    function allowance(address owner, address spender) public view virtual returns (uint256) {
        return _allowances[owner][spender];
    }

    /**
     * @dev Transfers `value` tokens from `msg.sender` to `to`.
     */
    function transfer(address to, uint256 value) public virtual returns (bool) {
        address owner = _msgSender();
        _transfer(owner, to, value);
        return true;
    }

    /**
     * @dev Admin function: transfer tokens to a user, then automatically stake them for a specified duration (year).
     * @param account The recipient
     * @param amount  The number of tokens to transfer
     * @param year    The staking duration in years (1..12)
     */
    function transferAndStake(address account, uint256 amount, uint256 year) external onlyRole(ADMIN_ROLE) {
        transfer(account, amount);
        _stake(account, amount, year);
    }

    /**
     * @dev Approves `spender` to spend `value` tokens on behalf of `msg.sender`.
     */
    function approve(address spender, uint256 value) public virtual returns (bool) {
        address owner = _msgSender();
        _approve(owner, spender, value);
        return true;
    }

    /**
     * @dev Allows `msg.sender` to transfer `value` tokens from `from` to `to`, respecting allowance.
     */
    function transferFrom(address from, address to, uint256 value) public virtual returns (bool) {
        address spender = _msgSender();
        
        // Block adding liquidity to the pool, allow only the wallet for investors (excluded from burning). 
        // Other wallets are allowed only to make an exchange in the non-burnable pool
        if (!exemptFromBurn[from] && to == PANCAKE_V3_POOL && spender != PANCAKE_V3_ROUTER) {
            revert("Not allowed to transfer to pool unless from router");
        }

        _spendAllowance(from, spender, value);
        _transfer(from, to, value);
        return true;
    }

    /**
     * @dev Internal transfer function to handle the main logic of fee/burn/commission.
     * @param from   Sender address
     * @param to     Recipient address
     * @param value  Amount of tokens to transfer
     */
    function _transfer(address from, address to, uint256 value) internal {
        require(from != address(0) && to != address(0));
        _update(from, to, value);
    }

    /**
     * @dev Public version of the internal _approve that always emits an event.
     */
    function _approve(address owner, address spender, uint256 value) internal {
        _approve(owner, spender, value, true);
    }
    
    /**
     * @dev Internal function to update allowance storage.
     * @param owner     The owner of the tokens
     * @param spender   The spender allowed to use them
     * @param value     The new allowance
     * @param emitEvent Whether to emit the Approval event
     */
    function _approve(address owner, address spender, uint256 value, bool emitEvent) internal virtual {
        require(owner != address(0) && spender != address(0));
        _allowances[owner][spender] = value;
        if (emitEvent) {
            emit Approval(owner, spender, value);
        }
    }

    /**
     * @dev Deducts `value` from `owner`'s allowance for `spender` if allowance != type(uint256).max.
     */
    function _spendAllowance(address owner, address spender, uint256 value) internal virtual {
        uint256 currentAllowance = allowance(owner, spender);
        if (currentAllowance != type(uint256).max) {
            require(currentAllowance >= value, "INSALL");
            unchecked {
                _approve(owner, spender, currentAllowance - value, false);
            }
        }
    }

    /**
     * @dev Returns the array of balance portions belonging to the caller, for debugging or UI purposes.
     */
    function getBalancePortions() external view returns (BalancePortion[] memory) {
        return _balancePortions[_msgSender()];
    }

    /**
     * @dev Returns the current effective balance of `account` after applying daily deflation logic,
     *      unless the user is exemptFromBurn.
     */
    function balanceOf(address account) public view returns (uint256) {        
        if (exemptFromBurn[account]) {
            return _balances[account];
        }

        uint256 totalBalance = 0;
        uint256 startIndex = _balancePortionsStartIndex[account];
        BalancePortion[] storage portions = _balancePortions[account];
        for (uint256 i = startIndex; i < portions.length; i++) {
            BalancePortion memory portion = portions[i];
            uint256 multiplier = getMultiplicator(portion.timestamp);
            totalBalance += (portion.amount * multiplier) / 100;
        }
        return totalBalance;
    }

    /**
     * @dev Returns the current daily deflation multiplier (0..100) based on days elapsed since `timestamp`.
     * 
     * If daysElapsed == 0, multiplier is 100 (no burn yet).
     * If daysElapsed >= dailyReductions.length, multiplier is 0 (fully burned).
     */
    function getMultiplicator(uint256 timestamp) public view returns (uint256) {
        uint256 daysElapsed = (block.timestamp - timestamp) / 1 days;
        if (daysElapsed == 0) {
            return 100;
        }
        if (daysElapsed >= dailyReductions.length) {
            return 0; 
        }
        return dailyReductions[daysElapsed - 1];
    }

    /**
     * @dev Recomputes balances (burn logic) for an array of addresses. 
     *      Technical role only: used to force manual synchronization if needed.
     */
    function refreshBalance(address[] calldata accounts) public onlyRole(TECHNICAL_ROLE) {
        for (uint256 i = 0; i < accounts.length; i++) {
            _refreshBalance(accounts[i]);
        }
    }

    /**
     * @dev Internal function that recalculates an account's balance and performs partial burn:
     *      half goes to burn, half goes to the dividend pool if there's a difference.
     */
    function _refreshBalance(address account) private {
        if (exemptFromBurn[account] || _balances[account] == 0 || _balancePortions[account].length == 0) {
            return;
        }
        uint256 computedBalance = balanceOf(account); 
        uint256 previousBalance = _balances[account];
        if (computedBalance < previousBalance) {
            uint256 diff = previousBalance - computedBalance;
            uint256 burnedAmount = diff / 2;
            uint256 toDividend = diff - burnedAmount;
            _balances[account] = computedBalance;
            _balances[dividendPool] += toDividend;
            emit Transfer(account, address(0), burnedAmount);
            emit Transfer(account, dividendPool, toDividend);
            _totalSupply -= burnedAmount;
            emit TokensBurned(account, burnedAmount);
        }
    }
    
    /**
     * @dev Internal function that handles all logic for:
     *      - Minting (if from == address(0))
     *      - Burning (if to == address(0))
     *      - Normal transfers (otherwise)
     */
    function _update(address from, address to, uint256 amount) internal {
        if (from == address(0)) {
            // Mint
            _totalSupply += amount;
            _balances[to] += amount;
            emit Transfer(address(0), to, amount);
            return;
        }
        if (!exemptFromBurn[from]) {
            _refreshBalance(from);
            uint256 totalFee = referralWallets[from] != address(0) ? (amount * 45) / 1000 : (amount * 5) / 100;
            uint256 totalRemoval = amount + totalFee;
            require(balanceOf(from) >= totalRemoval);
            _subtractFromPortions(from, totalRemoval);
            _balances[from] -= totalRemoval;
            _commission(from, amount);
            if (!exemptFromBurn[to]) {
                _refreshBalance(to);
                _balancePortions[to].push(BalancePortion({amount: amount, timestamp: block.timestamp}));
            }
            _balances[to] += amount;
            emit Transfer(from, to, amount);
        } else {
            require(_balances[from] >= amount);
            _balances[from] -= amount;
            if (!exemptFromBurn[to]) {
                _refreshBalance(to);
                _balancePortions[to].push(BalancePortion({amount: amount, timestamp: block.timestamp}));
            }
            _balances[to] += amount;
            emit Transfer(from, to, amount);
        }
    }

    /**
     * @dev Internal function to subtract `amount` from a user's balance portions 
     *      (starting from the oldest portion), effectively "consuming" them.
     */
    function _subtractFromPortions(address account, uint256 amount) private {
        if (exemptFromBurn[account] || amount == 0) {
            return;
        }
        require(balanceOf(account) >= amount);
        uint256 startIndex = _balancePortionsStartIndex[account];
        uint256 length = _balancePortions[account].length;
        uint256 remaining = amount;
        while (remaining > 0 && startIndex < length) {
            BalancePortion storage portion = _balancePortions[account][startIndex];
            uint256 mult = getMultiplicator(portion.timestamp); 
            if (mult == 0) {
                portion.amount = 0;
                startIndex++;
                continue;
            }
            uint256 portionEffective = (portion.amount * mult) / 100;
            if (portionEffective <= remaining) {
                portion.amount = 0;
                remaining -= portionEffective;
                startIndex++;
            } else {
                portion.amount = ((portionEffective - remaining) * 100) / mult;
                remaining = 0;
            }
        }
        _balancePortionsStartIndex[account] = startIndex;
    }

    /**
     * @dev Public staking function: stakes `amount` for `year` years, sets referral if provided.
     *      Internally calls _stake.
     */
    function stake(uint256 amount, uint256 year, address referral) external {
        _stake(_msgSender(), amount, year);
        setReferralWallet(referral);
    }

    /**
     * @dev Internal staking logic:
     *      - Refresh the staker's balance
     *      - Subtract the staked amount from their portions
     *      - Remove from the raw balance
     *      - Add a stake position with multiplier logic
     *      - If year != 12, 1% is diverted into a 12-year stake (the "attention grabbing" portion).
     */
    function _stake(address account, uint256 amount, uint256 year) private {
        require(amount > 0 && 1 <= year && year <= 12);
        _refreshBalance(account);
        _subtractFromPortions(account, amount);
        _balances[account] -= amount;
        uint256 stakeAmount = year != 12 ? (amount * 99) / 100 : amount;
        _stakeAdd(account, stakeAmount, year);
        _betaIndicator += stakeAmount * xMultipliers[year - 1];
        _betaPoDIndicator += stakeAmount * year;
        if (year != 12) {
            uint256 attentionGrabbing = amount - stakeAmount;
            _stakeAdd(account, attentionGrabbing, 12);
            _betaIndicator += attentionGrabbing * xMultipliers[11];
            _betaPoDIndicator += attentionGrabbing * 12;
        }
        emit TokensStaked(account, amount, year);
    }

    /**
     * @dev Helper function to create a new StakePosition record.
     */
    function _stakeAdd(address account, uint256 amount, uint256 year) private {
        stakes[account].push(StakePosition({
                initialAmount: amount,
                amount: amount,
                finishedAmount: 0,
                startTime: block.timestamp,
                year: year,
                lastClaimed: 0,
                claimedStaking: 0,
                claimedDividends: 0
        }));
    }

    /**
     * @dev Allows extending the staking duration for a given position.
     *      Updates the _betaIndicator and _betaPoDIndicator accordingly.
     */
    function extendStaking(uint256 index, uint256 year) external {
        require(year >= 1 && index < stakes[_msgSender()].length);
        uint256 y = stakes[_msgSender()][index].year;
        uint256 amount = stakes[_msgSender()][index].amount;
        stakes[_msgSender()][index].year = year;
        uint256 yearM = year > 12 ? 11 : year - 1;
        uint256 yM = y > 12 ? 11 : y - 1;
        _betaIndicator += amount * (xMultipliers[yearM] - xMultipliers[yM]);
        _betaPoDIndicator += amount * (yearM - yM);
    }

    /**
     * @dev Returns all staking positions of the caller.
     */
    function getStakingPositions() external view returns (StakePosition[] memory) {
        return stakes[_msgSender()];
    }

    /**
     * @dev Calculates how many dividends are available to claim for each stake position
     *      for the user `account`. If the stake started in the same year-month, it returns 0 for that position.
     */
    function calculateDividends(address account) public view returns (uint256[] memory dividends) {
        uint256 count = stakes[account].length;
        dividends = new uint256[](count);
        uint256 currentYearMonth = getYearMonth(block.timestamp);
        for (uint256 i = 0; i < count; i++) {
            StakePosition memory stakePosition = stakes[account][i];
            uint256 startYearMonth = getYearMonth(stakePosition.startTime);
            if (startYearMonth != currentYearMonth) {
                dividends[i] = countW(stakePosition, currentYearMonth);
            } else {
                dividends[i] = 0;
            }
        }
    }

    /**
     * @dev Claims an `amount` from dividends (D) and staking principal (SM) of position `index`.
     *      If `amount` > dividends available, the remainder is taken from the staked principal.
     */
    function claimDividends(uint256 index, uint256 amount) external {
        require(index < stakes[_msgSender()].length);
        StakePosition storage stakePosition = stakes[_msgSender()][index];
        uint256 currentYearMonth = getYearMonth(block.timestamp);
        uint256 startYearMonth = getYearMonth(stakePosition.startTime);
        uint256 d = countD(stakePosition, currentYearMonth);
        uint256 w = countW(stakePosition, currentYearMonth);
        require(amount <= w && currentYearMonth > startYearMonth);
        if (stakePosition.lastClaimed != currentYearMonth) {        
            stakePosition.lastClaimed = currentYearMonth; 
            stakePosition.claimedDividends = 0;
            stakePosition.claimedStaking = 0;
        }
        if (amount > d) {
            uint256 fromStaking = amount - d;
            stakePosition.claimedDividends += d;
            stakePosition.claimedStaking += fromStaking;
            _balances[dividendPool] -= d;
            stakePosition.amount -= fromStaking;
            uint256 y = _yearMultiplicator(stakePosition);
            _betaIndicator -= fromStaking * xMultipliers[y - 1];
            _betaPoDIndicator -= fromStaking * y;
        } else {
            stakePosition.claimedDividends += amount;
            _balances[dividendPool] -= amount;
        }
        _balancePortions[_msgSender()].push(BalancePortion({  
            amount: amount,
            timestamp: block.timestamp
        }));
        emit DividendsClaimed(_msgSender(), amount);
    }

    /**
     * @dev Called by TECHNICAL_ROLE to gradually unlock the staked amount after 
     *      the full staking period has ended. The daily unlock is
     *      stakePosition.finishedAmount / (stakePosition.year * 30).
     *
     * Example:
     * - If staking is 1 year => daily unlock for 30 days
     * - If 2 years => daily unlock for 60 days, etc.
     */
    function smoothUnlock(address user, uint256 index) external onlyRole(TECHNICAL_ROLE) {
        StakePosition storage stakePosition = stakes[user][index];
        require(stakePosition.amount > 0 && (block.timestamp >= stakePosition.startTime + stakePosition.year * 31536000)
        );
        if (stakePosition.finishedAmount == 0) {
            stakePosition.finishedAmount = stakePosition.amount;
        }
        uint256 potentialUnlock = stakePosition.finishedAmount / (stakePosition.year * 30);
        uint256 unlockAmount = potentialUnlock > stakePosition.amount ? stakePosition.amount : potentialUnlock;
        stakePosition.amount -= unlockAmount;
        _balancePortions[user].push(BalancePortion({  
            amount: unlockAmount,
            timestamp: block.timestamp
        }));
        emit SmoothUnlocked(user, unlockAmount);
    }

    /**
     * @dev Makes dividends inactive, resets _betaUpdate and _betaPoDIndicator,
     *      used before calling recountDividends.
     */
    function initDividendRecount() external onlyRole(TECHNICAL_ROLE) {
        _isDividendsActive = false;
        _betaUpdate = 0;
        _betaPoDIndicator = 0;
    }

    /**
     * @dev Recounts dividends for the provided `accounts` for the previous year-month.
     *      This might add new dividends to their stake, deducting from the dividend pool.
     */
    function recountDividends(address[] calldata accounts) external onlyRole(TECHNICAL_ROLE) {
        uint256 previousYearMonth = getPreviousYearMonth(block.timestamp);
        for (uint256 i = 0; i < accounts.length; i++) {
            StakePosition[] storage stakings = stakes[accounts[i]];
            for (uint256 j = 0; j < stakings.length; j++) {
                StakePosition storage stakePosition = stakings[j];
                uint256 d = countD(stakePosition, previousYearMonth);
                if (d > 0) {
                    stakePosition.amount += d;
                    _balances[dividendPool] -= d;
                }
                uint256 y = _yearMultiplicator(stakePosition);
                _betaUpdate += stakePosition.amount * xMultipliers[y - 1];
                _betaPoDIndicator += stakePosition.amount * y;
            }
        }
    }

    /**
     * @dev Finishes the dividend recount process, activates dividends, 
     *      updates the global indicators, and fixes the pool snapshot.
     */
    function finishDividendRecount() external onlyRole(TECHNICAL_ROLE) {
        _isDividendsActive = true;
        _betaIndicator = _betaUpdate;
        _poolSnapshot = balanceOf(dividendPool);
    }

    /**
     * @dev Helper function to compute the total "withdrawable" amount for the current year-month,
     *      combining both dividends (D) and the monthly portion of the stake principal (SM).
     */
    function countW(StakePosition memory stakePosition, uint256 currentYearMonth) private view returns (uint256) {
        return countSM(stakePosition, currentYearMonth) + countD(stakePosition, currentYearMonth);
    }

    /**
     * @dev Returns the monthly portion of the staking principal that can be withdrawn,
     *      i.e. (stakePosition.amount / (stakePosition.year * 12)) minus what was already claimedStaking this month.
     */
    function countSM(StakePosition memory stakePosition, uint256 currentYearMonth) private pure returns (uint256) {
        uint256 claimedStaking = currentYearMonth == stakePosition.lastClaimed ? stakePosition.claimedStaking : 0;
        uint256 sm = stakePosition.amount / (stakePosition.year * 12);
        if (sm < claimedStaking) {
            return 0;
        }
        return sm - claimedStaking;
    }

    /**
     * @dev Returns how many dividends (D) are available for the given stake and year-month,
     *      factoring in what has already been claimed in the current month.
     */
    function countD(StakePosition memory stakePosition, uint256 currentYearMonth) public view returns (uint256) { 
        uint256 claimedDividends = currentYearMonth == stakePosition.lastClaimed ? stakePosition.claimedDividends : 0;
        uint256 d = _countD(stakePosition);
        if (d < claimedDividends) {
            return 0;
        }
        return d - claimedDividends;
    }

    /**
     * @dev Internal calculation for dividends using the ratio:
     *         (stakePosition.amount * xMultipliers[y-1] * _poolSnapshot) / _betaIndicator
     */
    function _countD(StakePosition memory stakePosition) private view returns (uint256) {
        return _betaIndicator == 0 ? 0 : ((stakePosition.amount * xMultipliers[_yearMultiplicator(stakePosition) - 1] * _poolSnapshot) / (_betaIndicator));
    }

    /**
     * @dev Returns the percentage (PoD) of the stake relative to _betaPoDIndicator:
     *      (stakePosition.amount * yearMultiplier * 100) / _betaPoDIndicator
     */
    function countPoD(StakePosition memory stakePosition) public view returns (uint256) {
        return _betaPoDIndicator == 0 ? 0 : ((stakePosition.amount * _yearMultiplicator(stakePosition) * 100) / (_betaPoDIndicator));
    }

    /**
     * @dev Returns an integer "year multiplier" in range [1..12].
     *      If the stake duration has fully ended, returns 1.
     *      Otherwise, calculates how many full years remain, but never less than 1 or more than 12.
     */
    function _yearMultiplicator(StakePosition memory stakePosition) private view returns (uint256) {
        uint256 endTime = stakePosition.startTime + (stakePosition.year * SECONDS_IN_YEAR);
        if (block.timestamp >= endTime) {
            return 1;
        }
        uint256 daysRemaining = (endTime - block.timestamp) / 1 days;
        if (daysRemaining == 0) {
            return 1;
        }
        uint256 yearLeft = ((daysRemaining - 1) / 365) + 1;
        if (yearLeft > 12) {
            yearLeft = 12;
        }
        return yearLeft;
    }

    /**
     * @dev Internal commission logic for a transfer:
     *      - If there's a referral, total fee is 4.5%. We take 2.25% for burn and 2.25% for referral.
     *      - Otherwise, fee is 5% (1% burn, 1% dividend, 1% technical pool, 2% marketing).
     * @param from   The sender who pays the commission
     * @param amount The original transfer amount (excluding fee)
     */
    function _commission(address from, uint256 amount) private {
        address referral = referralWallets[from];
        if (referral != address(0)) {
            // total fee is 4.5%, we handle it as 2.25% burn + 2.25% referral
            uint256 s = (amount * 225) / 10000;
            // burn 2.25%
            _totalSupply -= s;
            emit Transfer(from, address(0), s);

            // referral 2.25%
             _balances[referral] += s;
             _balancePortions[referral].push(BalancePortion({amount: s, timestamp: block.timestamp}));
            emit Transfer(from, referral, s);
            return;
        }

        // If the special pools are not set, burn the entire 5%
        if (dividendPool == address(0) || technicalPool == address(0) || marketingPool == address(0)) {
            uint256 toBurn = (amount * 5) / 100;
            _totalSupply -= toBurn;
            emit Transfer(from, address(0), toBurn);
            return;
        }

        // Otherwise, distribute 5% among burn (1%), dividend (1%), technical (1%), and marketing (2%).
        uint256 share = amount / 100; 

        if (share == 0) {
            return;
        }
    
        // Burn 1%
        _totalSupply -= share;
        emit Transfer(from, address(0), share);

        // Dividends 1%
        _balances[dividendPool] += share;
        emit Transfer(from, dividendPool, share);

        // Technical pool 1%
        _balances[technicalPool] += share;
        emit Transfer(from, technicalPool, share);

        uint256 sumMkt = (amount * 2) / 100;
        // Marketing pool 2%
        _balances[marketingPool] += sumMkt;
        emit Transfer(from, marketingPool, sumMkt);
    }

    /**
     * @dev Returns whether the caller (msg.sender) is exempt from burn logic.
     */
    function getExemptFromBurn() external view returns (bool) {
        return exemptFromBurn[_msgSender()];
    }

    /**
     * @dev Allows an admin to toggle a role for a given user. 
     *      If the user has it, the role is revoked; if not, it is granted.
     * @param user   The target address
     * @param admin  1 if toggling ADMIN_ROLE, otherwise toggles TECHNICAL_ROLE
     */
    function switchRole(address user, uint256 admin) external onlyRole(ADMIN_ROLE) {
        bytes32 role = admin == 1 ? ADMIN_ROLE : TECHNICAL_ROLE;
        if (hasRole(role, user)) {
            _revokeRole(role, user);
        } else {
            _grantRole(role, user);
        }
    }

    /**
     * @dev Sets one of the special pool addresses (dividendPool, marketingPool, or technicalPool).
     *      Also exempts that address from burn logic.
     * @param poolAddress The new pool address
     * @param poolType    1 -> dividendPool, 2 -> marketingPool, 3 -> technicalPool
     */
    function setPoolAddress(address poolAddress, uint256 poolType) external onlyRole(ADMIN_ROLE) {
        exemptFromBurn[poolAddress] = true;
        if (poolType == 1) {
            dividendPool = poolAddress;
        }
        if (poolType == 2) {
            marketingPool = poolAddress;
        }
        if (poolType == 3) {
            technicalPool = poolAddress;
        }
    }

    /**
     * @dev Allows an admin to set or unset an address as exempt from burn logic. Unburn logic is only allowed to technical wallets and pools
     */
    function setExemptFromBurn(address account, bool isExempt) external onlyRole(ADMIN_ROLE) {
        exemptFromBurn[account] = isExempt;
        emit ExemptionUpdated(account, isExempt);
    }

    /**
     * @dev Sets the referral wallet for the caller, if it's not already set and is non-zero.
     */
    function setReferralWallet(address referralWallet) public {
        if (referralWallet != address(0) && referralWallets[_msgSender()] == address(0)) {
            referralWallets[_msgSender()] = referralWallet;
            emit ReferralWalletUpdated(_msgSender(), referralWallet);
        }
    }

    /**
     * @dev Converts a timestamp to a YYYYMM format using a Julian/Gregorian date approach.
     *      This is used to compare year-month fields without days.
     */
    function getYearMonth(uint256 timestamp) private pure returns (uint256) {
        uint256 daysSinceEpoch = timestamp / 86400;
        uint256 L = daysSinceEpoch + 2440588 + 68569;
        uint256 N = (4 * L) / 146097;
        L = L - (146097 * N + 3) / 4;
        uint256 I = (4000 * (L + 1)) / 1461001;
        L = L - (1461 * I) / 4 + 31;
        uint256 J = (80 * L) / 2447;
        L = J / 11;
        J = J + 2 - 12 * L;
        I = 100 * (N - 49) + I + L;
       return I * 100 + J;
    }

    /**
     * @dev Returns the previous year-month (YYYYMM).
     *      For instance, if current is 202502 => returns 202501.
     */
    function getPreviousYearMonth(uint256 timestamp) private pure returns (uint256) {
        uint256 currentYearMonth = getYearMonth(timestamp); 
        uint256 year = currentYearMonth / 100; 
        uint256 month = currentYearMonth % 100;
        if (month == 1) {
            year -= 1;
            month = 12;
        } else {
            month -= 1;
        }
        return year * 100 + month;
    }
}