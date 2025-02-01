// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/utils/Context.sol";
import "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";


contract DeflationCoin is IERC20, AccessControl, IERC20Metadata, IERC20Errors {
    struct BalancePortion {
        uint256 amount;
        uint256 timestamp;
    }

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

    string private _name;
    string private _symbol;

    mapping(address account => mapping(address spender => uint256)) private _allowances;
    mapping(address => uint256) public _balances;
    mapping(address => BalancePortion[]) private _balancePortions;
    mapping(address => uint256) private _balancePortionsStartIndex;
    mapping(address => StakePosition[]) private stakes;
    mapping(address => bool) private exemptFromBurn; 
    mapping(address => address) private referralWallets;

    address public dividendPool;
    address public marketingPool;
    address public technicalPool;

    uint256 private _totalSupply;
    uint256 private _betaIndicator;
    uint256 private _betaUpdate;
    uint256 private _poolSnapshot;
    uint256 private _betaPoDIndicator;
    bool public _isDividendsActive;

    uint256 private constant SECONDS_IN_YEAR = 365 * 24 * 60 * 60; 
    uint256 private constant MAX_TOTAL_SUPPLY = 20999999 * 10 ** 18; 
    uint256[] private dailyReductions = [99, 97, 93, 85, 71, 48, 17, 0]; //[1, 2, 4, 8, 16, 32, 64, 100];
    uint256[] private xMultipliers = [1, 2, 3, 4, 5, 6, 7, 10, 12, 14, 16, 20];

    event TokensBurned(address indexed from, uint256 amount);
    event TokensStaked(address indexed staker, uint256 amount, uint256 year);
    event ExemptionUpdated(address indexed account, bool isExempt);
    event PoolUpdated(string poolName, address newAddress);
    event DividendsClaimed(address indexed account, uint256 amount);
    event SmoothUnlocked(address indexed account, uint256 amount);
    event ReferralWalletUpdated(address indexed account, address indexed referralWallet);

    bytes32 private constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 private constant TECHNICAL_ROLE = keccak256("TECHNICAL_ROLE");

    constructor() {
        _name = "DeflationCoin";
        _symbol = "DEF";
        _totalSupply = 0;
        _betaIndicator = 0;
        _betaPoDIndicator = 0;
        _betaUpdate = 0;
        _poolSnapshot = 0;
        _isDividendsActive = false;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);
        _grantRole(TECHNICAL_ROLE, msg.sender);
        exemptFromBurn[msg.sender] = true;
        _mint(msg.sender, MAX_TOTAL_SUPPLY); 
    }

    function totalSupply() public view returns (uint256) {
        return _totalSupply;
    }

    function name() public view returns (string memory) {
        return _name;
    }

    function symbol() public view virtual returns (string memory) {
        return _symbol;
    }

    function decimals() public view virtual returns (uint8) {
        return 18;
    }

    function allowance(address owner, address spender) public view virtual returns (uint256) {
        return _allowances[owner][spender];
    }

    function transfer(address to, uint256 value) public virtual returns (bool) {
        address owner = _msgSender();
        _transfer(owner, to, value);
        return true;
    }

    function approve(address spender, uint256 value) public virtual returns (bool) {
        address owner = _msgSender();
        _approve(owner, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) public virtual returns (bool) {
        address spender = _msgSender();
        _spendAllowance(from, spender, value);
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        if (from == address(0)) {
            revert ERC20InvalidSender(address(0));
        }
        if (to == address(0)) {
            revert ERC20InvalidReceiver(address(0));
        }
        _update(from, to, value);
    }

    function _mint(address account, uint256 value) internal {
        if (account == address(0)) {
            revert ERC20InvalidReceiver(address(0));
        }
        _update(address(0), account, value);
    }

    function _burn(address account, uint256 value) internal {
        if (account == address(0)) {
            revert ERC20InvalidSender(address(0));
        }
        _update(account, address(0), value);
    }

    function _approve(address owner, address spender, uint256 value) internal {
        _approve(owner, spender, value, true);
    }

    function _approve(address owner, address spender, uint256 value, bool emitEvent) internal virtual {
        if (owner == address(0)) {
            revert ERC20InvalidApprover(address(0));
        }
        if (spender == address(0)) {
            revert ERC20InvalidSpender(address(0));
        }
        _allowances[owner][spender] = value;
        if (emitEvent) {
            emit Approval(owner, spender, value);
        }
    }

    function _spendAllowance(address owner, address spender, uint256 value) internal virtual {
        uint256 currentAllowance = allowance(owner, spender);
        if (currentAllowance != type(uint256).max) {
            if (currentAllowance < value) {
                revert ERC20InsufficientAllowance(spender, currentAllowance, value);
            }
            unchecked {
                _approve(owner, spender, currentAllowance - value, false);
            }
        }
    }

    function getBalancePortions() external view returns (BalancePortion[] memory) {
        return _balancePortions[msg.sender];
    }

    function getBalancePortionStart() external view returns (uint256) {
        return _balancePortionsStartIndex[msg.sender];
    }

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

    function balanceOfStatic(address account) public view returns (uint256) {
        return _balances[account];
    }

    function getMultiplicator(uint256 timestamp) public view returns (uint256) {
        uint256 daysElapsed = (block.timestamp - timestamp) / 1 days;
        if (daysElapsed == 0) {
            return 100;
        }

        if (daysElapsed >= dailyReductions.length) {
            return 0; 
        }

        return dailyReductions[daysElapsed];
    }

    function refreshBalance(address[] calldata accounts) public onlyRole(TECHNICAL_ROLE) {
        for (uint256 i = 0; i < accounts.length; i++) {
            _refreshBalance(accounts[i]);
        }
    }

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

    function _update(address from, address to, uint256 amount) internal {
        if (from == address(0)) {
            // Mint
            require(to != address(0), "ERC20InvalidReceiver");
            _totalSupply += amount;
            _balances[to] += amount;
            emit Transfer(address(0), to, amount);
            return;
        }

        if (to == address(0)) {
            // Burn
            require(_balances[from] >= amount, "no bal");
            if (!exemptFromBurn[from]) {
                _refreshBalance(from);
                _subtractFromPortions(from, amount);
            }
            _balances[from] -= amount;
            _totalSupply -= amount;
            emit Transfer(from, address(0), amount);
            return;
        }

        if (!exemptFromBurn[from]) {
            _refreshBalance(from);
            uint256 totalFee = 5 * amount / 100;
            uint256 totalRemoval = amount + totalFee;
            require(balanceOf(from) >= totalRemoval, "no bal");
            _subtractFromPortions(from, totalRemoval);
            _balances[from] -= totalRemoval;
            _commission(from, totalFee);

           if (!exemptFromBurn[to]) {
            _refreshBalance(to);
            _balancePortions[to].push(
                    BalancePortion({amount: amount, timestamp: block.timestamp})
                );
            }
            _balances[to] += amount;

            emit Transfer(from, to, amount);
        } else {
            require(_balances[from] >= amount, "no bal");
            _balances[from] -= amount;
            if (!exemptFromBurn[to]) {
                _refreshBalance(to);
                _balancePortions[to].push(
                    BalancePortion({amount: amount, timestamp: block.timestamp})
                );
            }
            _balances[to] += amount;
            emit Transfer(from, to, amount);
        }
    }

    function _subtractFromPortions(address account, uint256 amount) private {
        if (exemptFromBurn[account] || amount == 0) {
            return;
        }
        
        uint256 remaining = amount;
        require(balanceOf(account) >= amount, "no bal");

        uint256 startIndex = _balancePortionsStartIndex[account];
        uint256 length = _balancePortions[account].length;

        while (remaining > 0 && startIndex < length) {
            BalancePortion storage portion = _balancePortions[account][startIndex];
        
            if (portion.amount <= remaining) {
                remaining -= portion.amount;
                portion.amount = 0;
                startIndex++;
            } else {
                portion.amount -= remaining;
                remaining = 0;
            }
        }

        _balancePortionsStartIndex[account] = startIndex;

        require(remaining == 0, "no tok");
    }

    function stake(uint256 amount, uint256 year) external {
        require(amount > 0, "am<=0");
        require(1 <= year && year <= 12, "1<=y<=12");

        _refreshBalance(msg.sender);
        _subtractFromPortions(msg.sender, amount);
        _balances[msg.sender] -= amount;
        
        uint256 stakeAmount = year != 12 ? (amount * 99) / 100 : amount;
            
        stakes[msg.sender].push(StakePosition({
                initialAmount: stakeAmount,
                amount: stakeAmount,
                finishedAmount: 0,
                startTime: block.timestamp,
                year: year,
                lastClaimed: 0,
                claimedStaking: 0,
                claimedDividends: 0
            }));

        _betaIndicator += stakeAmount * xMultipliers[year - 1];
        _betaPoDIndicator += stakeAmount * year;

        if (year != 12) {
            uint256 attentionGrabbing = (amount * 1) / 100;
            stakes[msg.sender].push(StakePosition({
                initialAmount: attentionGrabbing,
                amount: attentionGrabbing,
                finishedAmount: 0,
                startTime: block.timestamp,
                year: 12,
                lastClaimed: 0,
                claimedStaking: 0,
                claimedDividends: 0
            }));
            _betaIndicator += attentionGrabbing * xMultipliers[11];
            _betaPoDIndicator += attentionGrabbing * 12;
        }

        emit TokensStaked(msg.sender, amount, year);
    }

    function extendStaking(uint256 index, uint256 year) external {
        require(year >= 1, "min 1y");
        require(index < stakes[msg.sender].length);
        uint256 y = stakes[msg.sender][index].year;
        uint256 amount = stakes[msg.sender][index].amount;
        stakes[msg.sender][index].year = year;
        _betaIndicator += amount * (xMultipliers[stakes[msg.sender][index].year - 1] - xMultipliers[y - 1]);
        _betaPoDIndicator += amount * (stakes[msg.sender][index].year - y);
    }

    function getStakingPositions() external view returns (StakePosition[] memory) {
        return stakes[msg.sender];
    }

    function calculateDividends(address account) public view returns (uint256[] memory shares) {
        uint256 count = stakes[account].length;
        uint256[] memory dividends = new uint256[](count);
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

        return dividends;
    }

    function claimDividends(uint256 index, uint256 amount) external {
        require(index < stakes[msg.sender].length);
        
        StakePosition storage stakePosition = stakes[msg.sender][index];
        uint256 currentYearMonth = getYearMonth(block.timestamp);
        uint256 startYearMonth = getYearMonth(stakePosition.startTime);
        require(currentYearMonth > startYearMonth);

        uint256 d = countD(stakePosition, currentYearMonth);
        uint256 w = countW(stakePosition, currentYearMonth);

        require(amount <= w);

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

        _balancePortions[msg.sender].push(BalancePortion({  
            amount: amount,
            timestamp: block.timestamp
        }));

        emit DividendsClaimed(msg.sender, amount);
    }

    function smoothUnlock(address user, uint256 index) external onlyRole(TECHNICAL_ROLE) {
        StakePosition storage stakePosition = stakes[user][index];
        require(stakePosition.amount > 0);
        require(block.timestamp >= stakePosition.startTime + stakePosition.year * 31536000);
        if (stakePosition.amount > 0 && stakePosition.finishedAmount == 0) {
            stakePosition.finishedAmount = stakePosition.amount;
        }

        uint256 potentialUnlock = stakePosition.finishedAmount / (stakePosition.year * 30);
        uint256 unlock = potentialUnlock > stakePosition.amount ? stakePosition.amount : potentialUnlock;
        stakePosition.amount -= unlock;
        _balancePortions[user].push(BalancePortion({  
            amount: unlock,
            timestamp: block.timestamp
        }));
        emit SmoothUnlocked(user, unlock);
    }

    function initDividendRecount() external onlyRole(TECHNICAL_ROLE) {
        _isDividendsActive = false;
        _betaUpdate = 0;
        _betaPoDIndicator = 0;
    }

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

    function finishDividendRecount() external onlyRole(TECHNICAL_ROLE) {
        _isDividendsActive = true;
        _betaIndicator = _betaUpdate;
        _poolSnapshot = balanceOf(dividendPool);
    }

    function countW(StakePosition memory stakePosition, uint256 currentYearMonth) private view returns (uint256) {
        return countSM(stakePosition, currentYearMonth) + countD(stakePosition, currentYearMonth);
    }

    function countSM(StakePosition memory stakePosition, uint256 currentYearMonth) private pure returns (uint256) {
        uint256 claimedStaking = currentYearMonth == stakePosition.lastClaimed ? stakePosition.claimedStaking : 0;
        uint256 sm = stakePosition.amount / (stakePosition.year * 12);
        if (sm < claimedStaking) {
            return 0;
        }
        return sm - claimedStaking;
    }

    function countD(StakePosition memory stakePosition, uint256 currentYearMonth) private view returns (uint256) { 
        uint256 claimedDividends = currentYearMonth == stakePosition.lastClaimed ? stakePosition.claimedDividends : 0;
        uint256 d = _countD(stakePosition);
        if (d < claimedDividends) {
            return 0;
        }
        return d - claimedDividends;
    }

    function _countD(StakePosition memory stakePosition) private view returns (uint256) {
        if (_betaIndicator == 0) {
            return 0;
        }
        uint256 year = _yearMultiplicator(stakePosition);
        return ((stakePosition.amount * xMultipliers[year - 1] * _poolSnapshot) / (_betaIndicator));
    }

    function countPoD(StakePosition memory stakePosition) public view returns (uint256) {
        if (_betaPoDIndicator == 0) {
            return 0;
        }
        uint256 year = _yearMultiplicator(stakePosition);
        return ((stakePosition.amount * year * 100) / (_betaPoDIndicator));
    }

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

    function _commission(address from, uint256 amount) private {
        uint256 burnAmount = amount / 100; 
        uint256 toDividend = amount / 100;
        uint256 toTechnical = amount / 100;
        uint256 toMarketing = amount / 100;
        uint256 toPartner = amount / 100;

        if (burnAmount > 0) {
            _totalSupply -= burnAmount;
            emit Transfer(from, address(0), burnAmount);
        }

        if (toDividend > 0) {
            if (dividendPool == address(0)) {
                _totalSupply -= toDividend;
                emit Transfer(from, address(0), toDividend);
            } else {
                _balances[dividendPool] += toDividend;
                emit Transfer(from, dividendPool, toDividend);
            }
        }

        if (toTechnical > 0) {
            if (technicalPool == address(0)) {
                _totalSupply -= toTechnical;
                emit Transfer(from, address(0), toTechnical);
            } else {
                _balances[technicalPool] += toTechnical;
                emit Transfer(from, technicalPool, toTechnical);
            }
        }

        if (marketingPool == address(0)) {
            uint256 toBurn = toMarketing + toPartner;
            if (toBurn > 0) {
                _totalSupply -= toBurn;
                emit Transfer(from, address(0), toBurn);
            }
        } else {
            address referral = referralWallets[from];
            if (referral != address(0)) {
                if (toPartner > 0) {
                    _balances[referral] += toPartner;
                    emit Transfer(from, referral, toPartner);
                }
                if (toMarketing > 0) {
                    _balances[marketingPool] += toMarketing;
                    emit Transfer(from, marketingPool, toMarketing);
                }
            } else {
                uint256 sumMkt = toPartner + toMarketing;
                if (sumMkt > 0) {
                    _balances[marketingPool] += sumMkt;
                    emit Transfer(from, marketingPool, sumMkt);
                }
            }
        }
    }

    function getExemptFromBurn() external view returns (bool) {
        return exemptFromBurn[msg.sender];
    }

    function getMyRoles() external view returns (string memory) {
        if (hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            return "DEFAULT_ADMIN_ROLE"; 
        } else if (hasRole(ADMIN_ROLE, msg.sender)) {
            return "ADMIN_ROLE";
        } else if (hasRole(TECHNICAL_ROLE, msg.sender)) {
            return "TECHNICAL_ROLE";
        } else {
            return "USER_ROLE";
        }
    }

    function switchRole(address user, uint256 admin) external onlyRole(ADMIN_ROLE) {
        bytes32 role = admin == 1 ? ADMIN_ROLE : TECHNICAL_ROLE;
        if (hasRole(role, user)) {
            _revokeRole(role, user);
        } else {
            _grantRole(role, user);
        }
    }

    function setPoolAddress(address poolAddress, uint256 poolType) external onlyRole(ADMIN_ROLE) {
        require(poolAddress != address(0));
        require(poolType >= 1 && poolType <= 3);
        exemptFromBurn[poolAddress] = true;
        if (poolType == 1) {
            dividendPool = poolAddress;
            emit PoolUpdated("dividends", poolAddress);
        }
        if (poolType == 2) {
            marketingPool = poolAddress;
            emit PoolUpdated("marketing", poolAddress);
        }
        if (poolType == 3) {
            technicalPool = poolAddress;
            emit PoolUpdated("technical", poolAddress);
        }
    }

    function setExemptFromBurn(address account, bool isExempt) external onlyRole(ADMIN_ROLE) {
        exemptFromBurn[account] = isExempt;
        emit ExemptionUpdated(account, isExempt);
    }

    function setReferralWallet(address referralWallet) external {
        require(referralWallet != address(0));
        referralWallets[msg.sender] = referralWallet;
        emit ReferralWalletUpdated(msg.sender, referralWallet);
    }

    function getYearMonth(uint256 timestamp) public pure returns (uint256) {
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

    function getPreviousYearMonth(uint256 timestamp) public pure returns (uint256) {
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