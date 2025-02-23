// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract DeflationCoinProxy {
    // Storage slot for the implementation address according to EIP1967:
    // bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1)
    bytes32 private constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    // Storage slot for the admin address according to EIP1967:
    // bytes32(uint256(keccak256('eip1967.proxy.admin')) - 1)
    bytes32 private constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e015b058f0a0a4f03e11a304ad5b7b3b3;

    /// @notice Constructor accepts the logic (implementation) address (_logic) and initialization data (_data)
    constructor(address _logic, bytes memory _data) {
        _setAdmin(msg.sender);
        _setImplementation(_logic);
        if (_data.length > 0) {
            (bool success, ) = _logic.delegatecall(_data);
            require(success, "Initialization failed");
        }
    }

    fallback() external payable {
        _delegate(_implementation());
    }
    
    receive() external payable {
        _delegate(_implementation());
    }
    
    /// @dev Delegates the call to the specified implementation.
    function _delegate(address impl) internal virtual {
        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return (0, returndatasize()) }
        }
    }
    
    /// @dev Returns the current implementation address stored in IMPLEMENTATION_SLOT.
    function _implementation() internal view returns (address impl) {
        bytes32 slot = IMPLEMENTATION_SLOT;
        assembly {
            impl := sload(slot)
        }
    }
    
    /// @dev Returns the admin address stored in ADMIN_SLOT.
    function _admin() internal view returns (address adm) {
        bytes32 slot = ADMIN_SLOT;
        assembly {
            adm := sload(slot)
        }
    }
    
    modifier ifAdmin() {
        require(msg.sender == _admin(), "Only admin can call");
        _;
    }
    
    /// @notice Updates the implementation address (callable by admin).
    function upgradeTo(address newImplementation) external ifAdmin {
        require(newImplementation != address(0), "Implementation address cannot be zero");
        _setImplementation(newImplementation);
    }
    
    function _setImplementation(address newImplementation) internal {
        bytes32 slot = IMPLEMENTATION_SLOT;
        assembly {
            sstore(slot, newImplementation)
        }
    }
    
    function _setAdmin(address newAdmin) internal {
        bytes32 slot = ADMIN_SLOT;
        assembly {
            sstore(slot, newAdmin)
        }
    }
    
    // Additional functions for admin:
    function admin() external view ifAdmin returns (address) {
        return _admin();
    }
    
    function implementation() external view ifAdmin returns (address) {
        return _implementation();
    }
}
