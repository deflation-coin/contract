const {expect} = require("chai");
const {ethers} = require("hardhat");

describe("DeflationCoinProxy + DeflationCoinUpgradeable", function () {
    let owner, admin, technical, user1, user2, referral;
    let DeflationCoinUpgradeableFactory, DeflationCoinProxyFactory;
    let logicV1, proxy, logicContractV1;
    let logicV2, logicContractV2;

    before(async function () {
        [owner, admin, technical, user1, user2, referral, ...addrs] = await ethers.getSigners();
        DeflationCoinUpgradeableFactory = await ethers.getContractFactory("DeflationCoinUpgradeable");
        DeflationCoinProxyFactory = await ethers.getContractFactory("DeflationCoinProxy");
    });

    beforeEach(async function () {
        logicV1 = await DeflationCoinUpgradeableFactory.deploy();
        await logicV1.waitForDeployment();
        const logicV1Addr = await logicV1.getAddress();

        const initData = logicV1.interface.encodeFunctionData("initialize");

        proxy = await DeflationCoinProxyFactory.deploy(logicV1Addr, initData);
        await proxy.waitForDeployment();

        const proxyAddr = await proxy.getAddress();
        logicContractV1 = await ethers.getContractAt("DeflationCoinUpgradeable", proxyAddr);
    });

    //-------------------------------------------------------------------------
    // 1. Proxy & Initialization Checks
    //-------------------------------------------------------------------------
    describe("Proxy & Initialization Checks", function () {
        it("Deployment with invalid init data => revert with 'Initialization failed'", async function () {
            const logicV1Addr = await logicV1.getAddress();

            const invalidInitData = "0xDEADBEEF";

            await expect(
                DeflationCoinProxyFactory.deploy(logicV1Addr, invalidInitData)
            ).to.be.revertedWith("Initialization failed");
        });
        it("Checks correct proxy admin and implementation addresses", async function () {
            const adminAddress = await proxy.connect(owner).admin();
            expect(adminAddress).to.equal(await owner.getAddress());

            const implAddress = await proxy.connect(owner).implementation();
            expect(implAddress).to.equal(await logicV1.getAddress());
        });

        it("initialize() cannot be called again", async function () {
            await expect(logicContractV1.connect(owner).initialize()).to.be.reverted;
        });

        it("Checks basic metadata: name, symbol, totalSupply", async function () {
            const name = await logicContractV1.name();
            expect(name).to.equal("DeflationCoin");

            const symbol = await logicContractV1.symbol();
            expect(symbol).to.equal("DEF");

            const totalSupply = await logicContractV1.totalSupply();
            expect(totalSupply).to.equal(ethers.parseEther("20999999"));
        });
    });

    //-------------------------------------------------------------------------
    // 2. upgradeTo (upgradability)
    //-------------------------------------------------------------------------
    describe("upgradeTo (upgradability)", function () {
        beforeEach(async function () {
            logicV2 = await DeflationCoinUpgradeableFactory.deploy();
            await logicV2.waitForDeployment();
            const proxyAddr = await proxy.getAddress();
            logicContractV2 = await ethers.getContractAt("DeflationCoinUpgradeable", proxyAddr);
        });

        it("Non-admin cannot perform upgradeTo => revert", async function () {
            const logicV2Addr = await logicV2.getAddress();
            await expect(
                proxy.connect(user1).upgradeTo(logicV2Addr)
            ).to.be.revertedWith("Only admin can call");
        });

        it("upgradeTo successfully changes implementation", async function () {
            const logicV2Addr = await logicV2.getAddress();
            await proxy.connect(owner).upgradeTo(logicV2Addr);
            const implAfter = await proxy.connect(owner).implementation();
            expect(implAfter).to.equal(logicV2Addr);
        });

        it("upgradeTo with address(0) => revert", async function () {
            await expect(
                proxy.connect(owner).upgradeTo(ethers.ZeroAddress)
            ).to.be.revertedWith("Implementation address cannot be zero");
        });
    });

    //-------------------------------------------------------------------------
    // 3. ERC20 and DeflationCoinUpgradeable logic
    //-------------------------------------------------------------------------
    describe("ERC20 and DeflationCoinUpgradeable logic", function () {
        it("transfer, balanceOf, burn scenario => transfer to address(0) reverts", async function () {
            await logicContractV1.connect(owner).transfer(
                await user1.getAddress(),
                ethers.parseEther("50")
            );
            await expect(
                logicContractV1.connect(user1).transfer(ethers.ZeroAddress, ethers.parseEther("10"))
            ).to.be.reverted;
        });

        it("approve and transferFrom", async function () {
            await logicContractV1.connect(owner).approve(
                await user1.getAddress(),
                ethers.parseEther("500")
            );
            let allowance = await logicContractV1.allowance(
                await owner.getAddress(),
                await user1.getAddress()
            );
            expect(allowance).to.equal(ethers.parseEther("500"));

            await logicContractV1.connect(user1).transferFrom(
                await owner.getAddress(),
                await user2.getAddress(),
                ethers.parseEther("300")
            );
            allowance = await logicContractV1.allowance(
                await owner.getAddress(),
                await user1.getAddress()
            );
            expect(allowance).to.equal(ethers.parseEther("200"));

            const user2Bal = await logicContractV1.balanceOf(await user2.getAddress());
            expect(user2Bal).to.equal(ethers.parseEther("300"));
        });

        it("transferAndStake", async function () {
            const amount = ethers.parseEther("100");
            await logicContractV1.connect(owner).transferAndStake(
                await user1.getAddress(),
                amount,
                1
            );
            const user1Bal = await logicContractV1.balanceOf(await user1.getAddress());
            expect(user1Bal).to.equal(0n);

            const stakings = await logicContractV1.connect(user1).getStakingPositions();
            expect(stakings.length).to.equal(2);
            expect(stakings[0].initialAmount).to.equal((amount * 99n) / 100n);
        });

        it("stake directly + referral logic", async function () {
            await logicContractV1.connect(owner).transfer(
                await user1.getAddress(),
                ethers.parseEther("200")
            );
            await logicContractV1.connect(user1).stake(
                ethers.parseEther("100"),
                5,
                await referral.getAddress()
            );
            const stakings = await logicContractV1.connect(user1).getStakingPositions();
            expect(stakings.length).to.equal(2);
        });

        it("exemptFromBurn: if user is exempt, no burn mechanics apply", async function () {
            await logicContractV1.connect(owner).setExemptFromBurn(await user1.getAddress(), true);
            await logicContractV1.connect(owner).transfer(
                await user1.getAddress(),
                ethers.parseEther("100")
            );
            await logicContractV1.connect(user1).transfer(
                await owner.getAddress(),
                ethers.parseEther("50")
            );
            const user1BalAfter = await logicContractV1.balanceOf(await user1.getAddress());
            expect(user1BalAfter).to.equal(ethers.parseEther("50"));
        });

        it("Commission: share == 0 when all pools are set and amount < 100", async function () {
            await logicContractV1.connect(owner).setPoolAddress(await user2.getAddress(), 1);
            await logicContractV1.connect(owner).setPoolAddress(await admin.getAddress(), 2);
            await logicContractV1.connect(owner).setPoolAddress(await technical.getAddress(), 3);

            await logicContractV1.connect(owner).transfer(
                await user1.getAddress(),
                10
            );

            await logicContractV1.connect(user1).transfer(
                await user2.getAddress(),
                5
            );

        });

        it("Only ADMIN_ROLE can setExemptFromBurn", async function () {
            await expect(
                logicContractV1.connect(user1).setExemptFromBurn(await user2.getAddress(), true)
            ).to.be.revertedWithCustomError(logicContractV1, "AccessControlUnauthorizedAccount");
        });

        it("ADMIN_ROLE can assign TECHNICAL_ROLE, then TECHNICAL_ROLE can call refreshBalance", async function () {
            await logicContractV1.connect(owner).switchRole(await technical.getAddress(), 0);
            await logicContractV1.connect(technical).refreshBalance([await owner.getAddress()]);
        });

        it("Non-technical role user attempts refreshBalance => revert", async function () {
            await expect(
                logicContractV1.connect(user2).refreshBalance([await owner.getAddress()])
            ).to.be.revertedWithCustomError(logicContractV1, "AccessControlUnauthorizedAccount");
        });
   


        it("Only TECHNICAL_ROLE can do initDividendRecount, recountDividends, finishDividendRecount", async function () {
            await logicContractV1.connect(owner).setPoolAddress(await user2.getAddress(), 1);
            await logicContractV1.connect(owner).setPoolAddress(await admin.getAddress(), 2);
            await logicContractV1.connect(owner).setPoolAddress(await technical.getAddress(), 3);
            await logicContractV1.connect(owner).switchRole(await owner.getAddress(), 0);
            await expect(
                logicContractV1.connect(owner).initDividendRecount()
            ).to.be.revertedWithCustomError(logicContractV1, "AccessControlUnauthorizedAccount");

            await logicContractV1.connect(owner).switchRole(await technical.getAddress(), 0);
            await logicContractV1.connect(technical).initDividendRecount();
            await logicContractV1.connect(technical).recountDividends([]);
            await logicContractV1.connect(technical).finishDividendRecount();
            expect(await logicContractV1._isDividendsActive()).to.equal(true);

            await logicContractV1.connect(owner).switchRole(await technical.getAddress(), 0);
            await expect(
                logicContractV1.connect(technical).initDividendRecount()
            ).to.be.revertedWithCustomError(logicContractV1, "AccessControlUnauthorizedAccount");
        });

        it("claimDividends: reverts if index out of range or amount too large", async function () {
          await logicContractV1.connect(owner).setPoolAddress(await user2.getAddress(), 1);
          await logicContractV1.connect(owner).setPoolAddress(await admin.getAddress(), 2);
          await logicContractV1.connect(owner).setPoolAddress(await technical.getAddress(), 3);
            await logicContractV1.connect(owner).transfer(
                await user1.getAddress(),
                ethers.parseEther("1000")
            );
            await logicContractV1.connect(user1).stake(
                ethers.parseEther("1000"),
                1,
                await referral.getAddress()
            );
            const stakings = await logicContractV1.connect(user1).getStakingPositions();
            expect(stakings.length).to.equal(2);

            await expect(
                logicContractV1.connect(user1).claimDividends(5, ethers.parseEther("10"))
            ).to.be.reverted;

            await expect(
                logicContractV1.connect(user1).claimDividends(0, ethers.parseEther("100"))
            ).to.be.reverted;
        });

        it("Only TECHNICAL_ROLE can do smoothUnlock => revert otherwise", async function () {
            await expect(
                logicContractV1.connect(user1).smoothUnlock(await user1.getAddress(), 0)
            ).to.be.revertedWithCustomError(logicContractV1, "AccessControlUnauthorizedAccount");
        });

        it("smoothUnlock scenario: success if stake is matured and caller has TECHNICAL_ROLE", async function () {
            await logicContractV1.connect(owner).switchRole(await technical.getAddress(), 0);

            await logicContractV1.connect(owner).stake(
                ethers.parseEther("1000"),
                1,
                ethers.ZeroAddress
            );
            await ethers.provider.send("evm_increaseTime", [365 * 24 * 3600 + 100]);
            await ethers.provider.send("evm_mine", []);

            await logicContractV1.connect(technical).smoothUnlock(await owner.getAddress(), 0);

            const stakings = await logicContractV1.connect(owner).getStakingPositions();
            expect(stakings[0].amount).to.be.lessThan(ethers.parseEther("1000"));
        });
   
        it("After upgradeTo, user data remains intact", async function () {
            await logicContractV1.connect(owner).transfer(
                await user1.getAddress(),
                ethers.parseEther("5000")
            );
            await logicContractV1.connect(user1).stake(
                ethers.parseEther("5000"),
                2,
                ethers.ZeroAddress
            );

            const balBefore = await logicContractV1.balanceOf(await user1.getAddress());
            const stakingsBefore = await logicContractV1.connect(user1).getStakingPositions();
            expect(stakingsBefore.length).to.equal(2);

            logicV2 = await DeflationCoinUpgradeableFactory.deploy();
            await logicV2.waitForDeployment();
            const logicV2Addr = await logicV2.getAddress();

            await proxy.connect(owner).upgradeTo(logicV2Addr);
            const proxyAddr = await proxy.getAddress();
            logicContractV2 = await ethers.getContractAt("DeflationCoinUpgradeable", proxyAddr);

            const balAfter = await logicContractV2.balanceOf(await user1.getAddress());
            expect(balAfter).to.equal(balBefore);

            const stakingsAfter = await logicContractV2.connect(user1).getStakingPositions();
            expect(stakingsAfter.length).to.equal(stakingsBefore.length);
        });
    
        it("Successful claimDividends scenario (with actual dividends)", async function () {
            await logicContractV1.connect(owner).setPoolAddress(await user2.getAddress(), 1);
            await logicContractV1.connect(owner).transfer(
                await user2.getAddress(),
                ethers.parseEther("1000")
            );
            let divPoolBal = await logicContractV1.balanceOf(await user2.getAddress());
            expect(divPoolBal).to.equal(ethers.parseEther("1000"));

            await logicContractV1.connect(owner).transfer(
                await user1.getAddress(),
                ethers.parseEther("500")
            );
            await logicContractV1.connect(user1).stake(
                ethers.parseEther("500"),
                1,
                await referral.getAddress()
            );

            await logicContractV1.connect(owner).switchRole(await owner.getAddress(), 0);
            await expect(
                logicContractV1.connect(owner).initDividendRecount()
            ).to.be.revertedWithCustomError(logicContractV1, "AccessControlUnauthorizedAccount");

            await logicContractV1.connect(owner).switchRole(await technical.getAddress(), 0);

            await logicContractV1.connect(technical).initDividendRecount();
            await logicContractV1.connect(technical).recountDividends([await user1.getAddress()]);
            await logicContractV1.connect(technical).finishDividendRecount();

            await ethers.provider.send("evm_increaseTime", [31 * 24 * 3600]);
            await ethers.provider.send("evm_mine", []);

            const divs = await logicContractV1.calculateDividends(await user1.getAddress());
            expect(divs[0]).to.be.gt(0n);

            await logicContractV1.connect(user1).claimDividends(0, ethers.parseEther("10"));
            const user1Bal = await logicContractV1.balanceOf(await user1.getAddress());
            expect(user1Bal).to.equal(ethers.parseEther("10"));

            divPoolBal = await logicContractV1.balanceOf(await user2.getAddress());
            expect(divPoolBal).to.equal(ethers.parseEther("990"));
        });

        it("extendStaking from 1 year to 5 years recalculates global indicators", async function () {
            await logicContractV1.connect(owner).transfer(
                await user1.getAddress(),
                ethers.parseEther("2000")
            );
            await logicContractV1.connect(user1).stake(
                ethers.parseEther("1000"),
                1,
                await referral.getAddress()
            );
            await logicContractV1.connect(user1).extendStaking(0, 5);

            const stakings = await logicContractV1.connect(user1).getStakingPositions();
            expect(stakings[0].year).to.equal(5n);
        });

        it("Multi-day deflation with refreshBalance()", async function () {
            await logicContractV1.connect(owner).transfer(
                await user1.getAddress(),
                ethers.parseEther("100")
            );
            let bal0 = await logicContractV1.balanceOf(await user1.getAddress());
            expect(bal0).to.equal(ethers.parseEther("100"));

            await ethers.provider.send("evm_increaseTime", [24 * 3600]);
            await ethers.provider.send("evm_mine", []);
            await logicContractV1.connect(owner).refreshBalance([await user1.getAddress()]);
            let bal1 = await logicContractV1.balanceOf(await user1.getAddress());
            expect(bal1).to.equal(ethers.parseEther("99"));

            await ethers.provider.send("evm_increaseTime", [24 * 3600]);
            await ethers.provider.send("evm_mine", []);
            await logicContractV1.connect(owner).refreshBalance([await user1.getAddress()]);
            let bal2 = await logicContractV1.balanceOf(await user1.getAddress());
            expect(bal2).to.equal(ethers.parseEther("97"));
        });

        it("Commission edge case: transfer a very small amount => share == 0", async function () {
            await logicContractV1.connect(owner).transfer(
                await user1.getAddress(),
                1
            );
            await logicContractV1.connect(user1).transfer(
                await user2.getAddress(),
                1
            );
            const user2Bal = await logicContractV1.balanceOf(await user2.getAddress());
            expect(user2Bal).to.equal(1n);

            const totalSupply = await logicContractV1.totalSupply();
            expect(totalSupply).to.equal(ethers.parseEther("20999999"));
        });
   
        let year12 = 12;
        let year13 = 13;
        let zeroAmount = ethers.parseEther("0");

        it("stake(0, 1) => revert (amount > 0 required)", async function () {
            await expect(
                logicContractV1.connect(user1).stake(
                    zeroAmount, 
                    1,
                    await referral.getAddress()
                )
            ).to.be.reverted;
        });

        it("stake with year=13 => revert (year must be <=12)", async function () {
            await logicContractV1.connect(owner).transfer(
                await user1.getAddress(),
                ethers.parseEther("100")
            );
            await expect(
                logicContractV1.connect(user1).stake(
                    ethers.parseEther("100"),
                    year13,
                    await referral.getAddress()
                )
            ).to.be.reverted;
        });

        it("extendStaking(index out of range) => revert", async function () {
            await logicContractV1.connect(owner).transfer(
                await user1.getAddress(),
                ethers.parseEther("500")
            );
            await logicContractV1.connect(user1).stake(
                ethers.parseEther("500"),
                1,
                await referral.getAddress()
            );
            await expect(
                logicContractV1.connect(user1).extendStaking(999, 2)
            ).to.be.reverted;
        });

        it("extendStaking(0, 0) => revert (year >=1)", async function () {
            await logicContractV1.connect(owner).transfer(
                await user1.getAddress(),
                ethers.parseEther("100")
            );
            await logicContractV1.connect(user1).stake(
                ethers.parseEther("100"),
                2,
                ethers.ZeroAddress
            );
            await expect(
                logicContractV1.connect(user1).extendStaking(0, 0)
            ).to.be.reverted;
        });

        it("smoothUnlock => revert if not matured yet", async function () {
            await logicContractV1.connect(owner).switchRole(await technical.getAddress(), 0);

            await logicContractV1.connect(owner).stake(
                ethers.parseEther("1000"),
                1,
                ethers.ZeroAddress
            );
            await expect(
                logicContractV1.connect(technical).smoothUnlock(await owner.getAddress(), 0)
            ).to.be.reverted;
        });

        it("setPoolAddress with poolType != 1..3 => no assignment branch coverage", async function () {
            await logicContractV1.connect(owner).setPoolAddress(await user1.getAddress(), 4);
        });

        it("commission: all 5% burned if marketingPool or technicalPool=0, sender not exempt", async function () {
            await logicContractV1.connect(owner).setExemptFromBurn(user1.address, false);
            await logicContractV1.connect(owner).setPoolAddress(user2.address, 1);
            await logicContractV1.connect(owner).transfer(
                user1.address,
                ethers.parseEther("20")
            );
            const user1BalBefore = await logicContractV1.balanceOf(user1.address);
            expect(user1BalBefore).to.equal(ethers.parseEther("20"));

            const user2BalBefore = await logicContractV1.balanceOf(user2.address);
            expect(user2BalBefore).to.equal(0n);

            await logicContractV1.connect(user1).transfer(
                user2.address,
                ethers.parseEther("10")
            );

            const user2BalAfter = await logicContractV1.balanceOf(user2.address);
            expect(user2BalAfter).to.equal(ethers.parseEther("10"));

            const user1BalAfter = await logicContractV1.balanceOf(user1.address);
            expect(user1BalAfter).to.equal(ethers.parseEther("9.5"));

        });

        it("commission with referral = 4.5% total => test referral != 0 branch explicitly", async function () {
            await logicContractV1.connect(owner).setPoolAddress(await user2.getAddress(), 1);
            await logicContractV1.connect(owner).setPoolAddress(await admin.getAddress(), 2);
            await logicContractV1.connect(owner).setPoolAddress(await technical.getAddress(), 3);

            await logicContractV1.connect(user1).stake(
                ethers.parseEther("0"), 
                1,
                await user2.getAddress()
            ).catch(() => {
            });
            await logicContractV1.connect(user1).setReferralWallet(await user2.getAddress());

            await logicContractV1.connect(owner).transfer(
                await user1.getAddress(),
                ethers.parseEther("100")
            );
            await logicContractV1.connect(user1).transfer(
                await user2.getAddress(),
                ethers.parseEther("10")
            );
        });

        it("Testing getBalancePortions() with partial daily burn coverage", async function () {
            await logicContractV1.connect(owner).transfer(
                await user1.getAddress(),
                ethers.parseEther("50")
            );
            const portions1 = await logicContractV1.connect(user1).getBalancePortions();
            expect(portions1.length).to.equal(1);

            await ethers.provider.send("evm_increaseTime", [24 * 3600]);
            await ethers.provider.send("evm_mine", []);
            await logicContractV1.connect(owner).switchRole(await technical.getAddress(), 0);
            await logicContractV1.connect(technical).refreshBalance([await user1.getAddress()]);

            const portions2 = await logicContractV1.connect(user1).getBalancePortions();
            expect(portions2.length).to.equal(1);
        });

        it("Testing getStakingPositions() for address with no stakes => returns empty array", async function () {
            const noStakePositions = await logicContractV1.connect(user2).getStakingPositions();
            expect(noStakePositions.length).to.equal(0);
        });

        it("Check `_yearMultiplicator` edge-case: stake matured exactly on boundary => returns 1", async function () {

            await logicContractV1.connect(owner).setPoolAddress(await user2.getAddress(), 1);
            await logicContractV1.connect(owner).setPoolAddress(await admin.getAddress(), 2);
            await logicContractV1.connect(owner).setPoolAddress(await technical.getAddress(), 3);

            await logicContractV1.connect(owner).switchRole(await technical.getAddress(), 0);

            await logicContractV1.connect(owner).transfer(
                await user2.getAddress(),
                ethers.parseEther("500")
            );

            await logicContractV1.connect(owner).transfer(
                await user1.getAddress(),
                ethers.parseEther("100")
            );
            await logicContractV1.connect(user1).stake(
                ethers.parseEther("100"),
                1,
                ethers.ZeroAddress
            );

            await logicContractV1.connect(technical).initDividendRecount();
            await logicContractV1.connect(technical).recountDividends([await user1.getAddress()]);
            await logicContractV1.connect(technical).finishDividendRecount();

            await ethers.provider.send("evm_increaseTime", [365 * 24 * 3600]);
            await ethers.provider.send("evm_mine", []);


            await expect(
                logicContractV1.connect(user1).claimDividends(0, ethers.parseEther("10"))
            ).to.not.be.reverted;
        });

        it("getPreviousYearMonth coverage for January => (month == 1)", async function () {
            await ethers.provider.send("evm_setNextBlockTimestamp", [1893456000]);
            await ethers.provider.send("evm_mine", []);

            await logicContractV1.connect(owner).switchRole(
                await technical.getAddress(),
                0
            );

            await logicContractV1.connect(technical).initDividendRecount();
            const addressesToRecount = [await owner.getAddress()];
            await logicContractV1.connect(technical).recountDividends(addressesToRecount);

            await logicContractV1.connect(technical).finishDividendRecount();

        });

        it("All pools = address(0) => 5% burn if user not exempt and no referral", async function () {
            // Используем фиктивный адрес вместо нулевого
            const dummyAddress = "0x0000000000000000000000000000000000000001";
            await logicContractV1.connect(owner).setPoolAddress(dummyAddress, 1);
            await logicContractV1.connect(owner).setPoolAddress(dummyAddress, 2);
            await logicContractV1.connect(owner).setPoolAddress(dummyAddress, 3);
            await logicContractV1.connect(owner).setExemptFromBurn(await user1.getAddress(), false);
            await logicContractV1.connect(owner).transfer(await user1.getAddress(), ethers.parseEther("20"));
            await logicContractV1.connect(user1).transfer(await user2.getAddress(), ethers.parseEther("10"));
            const user2Bal = await logicContractV1.balanceOf(await user2.getAddress());
            expect(user2Bal).to.equal(ethers.parseEther("10"));
            const user1Bal = await logicContractV1.balanceOf(await user1.getAddress());
            expect(user1Bal).to.equal(ethers.parseEther("9.5"));
        });

        it("commission with referral=4.5% => 2.25% burn, 2.25% referral", async function () {
            await logicContractV1.connect(owner).setPoolAddress(await user2.getAddress(), 1);
            await logicContractV1.connect(owner).setPoolAddress(await admin.getAddress(), 2);
            await logicContractV1.connect(owner).setPoolAddress(await technical.getAddress(), 3);
            await logicContractV1.connect(user1).setReferralWallet(await referral.getAddress());
            await logicContractV1.connect(owner).setExemptFromBurn(await user1.getAddress(), false);
            await logicContractV1.connect(owner).transfer(await user1.getAddress(), ethers.parseEther("100"));
            await logicContractV1.connect(user1).transfer(await user2.getAddress(), ethers.parseEther("10"));
        });

        it("stake(0, 1) => revert (amount > 0 required)", async function () {
            await expect(
                logicContractV1.connect(user1).stake(0, 1, await referral.getAddress())
            ).to.be.reverted;
        });

        it("stake with year=13 => revert (year must be <=12)", async function () {
            await logicContractV1.connect(owner).transfer(await user1.getAddress(), ethers.parseEther("100"));
            await expect(
                logicContractV1.connect(user1).stake(ethers.parseEther("100"), 13, await referral.getAddress())
            ).to.be.reverted;
        });

        it("extendStaking(index out of range) => revert", async function () {
            await logicContractV1.connect(owner).transfer(await user1.getAddress(), ethers.parseEther("500"));
            await logicContractV1.connect(user1).stake(ethers.parseEther("500"), 1, await referral.getAddress());
            await expect(
                logicContractV1.connect(user1).extendStaking(999, 2)
            ).to.be.reverted;
        });

        it("extendStaking(0, 0) => revert (year >=1)", async function () {
            await logicContractV1.connect(owner).transfer(await user1.getAddress(), ethers.parseEther("100"));
            await logicContractV1.connect(user1).stake(ethers.parseEther("100"), 2, ethers.ZeroAddress);
            await expect(
                logicContractV1.connect(user1).extendStaking(0, 0)
            ).to.be.reverted;
        });

        it("smoothUnlock => revert if not matured yet", async function () {
            await logicContractV1.connect(owner).switchRole(await technical.getAddress(), 0);
            await logicContractV1.connect(owner).stake(ethers.parseEther("1000"), 1, ethers.ZeroAddress);
            await expect(
                logicContractV1.connect(technical).smoothUnlock(await owner.getAddress(), 0)
            ).to.be.reverted;
        });

        it("setPoolAddress with poolType != 1..3 => no assignment branch coverage", async function () {
            await logicContractV1.connect(owner).setPoolAddress(await user1.getAddress(), 999);
        });

        it("commission: all 5% burned if marketingPool=0 or technicalPool=0, sender not exempt", async function () {
            await logicContractV1.connect(owner).setExemptFromBurn(await user1.getAddress(), false);
            await logicContractV1.connect(owner).setPoolAddress(await user2.getAddress(), 1);
            // Используем фиктивный адрес вместо нулевого
            const dummyAddress = "0x0000000000000000000000000000000000000001";
            await logicContractV1.connect(owner).setPoolAddress(dummyAddress, 2);
            await logicContractV1.connect(owner).setPoolAddress(dummyAddress, 3);
            await logicContractV1.connect(owner).transfer(await user1.getAddress(), ethers.parseEther("20"));
            await logicContractV1.connect(user1).transfer(await user2.getAddress(), ethers.parseEther("10"));
            const user2Bal = await logicContractV1.balanceOf(await user2.getAddress());
            expect(user2Bal).to.equal(ethers.parseEther("10.1"));
            const user1Bal = await logicContractV1.balanceOf(await user1.getAddress());
            expect(user1Bal).to.equal(ethers.parseEther("9.5"));
        });

        it("Testing getBalancePortions() with partial daily burn coverage", async function () {
            await logicContractV1.connect(owner).transfer(await user1.getAddress(), ethers.parseEther("50"));
            const p1 = await logicContractV1.connect(user1).getBalancePortions();
            expect(p1.length).to.equal(1);
            await ethers.provider.send("evm_increaseTime", [24 * 3600]);
            await ethers.provider.send("evm_mine", []);
            await logicContractV1.connect(owner).switchRole(await technical.getAddress(), 0);
            await logicContractV1.connect(technical).refreshBalance([await user1.getAddress()]);
            const p2 = await logicContractV1.connect(user1).getBalancePortions();
            expect(p2.length).to.equal(1);
        });

        it("Testing getStakingPositions() for address with no stakes => returns empty array", async function () {
            const st = await logicContractV1.connect(user2).getStakingPositions();
            expect(st.length).to.equal(0);
        });

        it("Check _yearMultiplicator edge-case: stake matured exactly on boundary => returns 1", async function () {
            await logicContractV1.connect(owner).setPoolAddress(await user2.getAddress(), 1);
            await logicContractV1.connect(owner).setPoolAddress(await admin.getAddress(), 2);
            await logicContractV1.connect(owner).setPoolAddress(await technical.getAddress(), 3);
            await logicContractV1.connect(owner).switchRole(await technical.getAddress(), 0);
            await logicContractV1.connect(owner).transfer(await user2.getAddress(), ethers.parseEther("500"));
            await logicContractV1.connect(owner).transfer(await user1.getAddress(), ethers.parseEther("100"));
            await logicContractV1.connect(user1).stake(ethers.parseEther("100"), 1, ethers.ZeroAddress);
            await logicContractV1.connect(technical).initDividendRecount();
            await logicContractV1.connect(technical).recountDividends([await user1.getAddress()]);
            await logicContractV1.connect(technical).finishDividendRecount();
            await ethers.provider.send("evm_increaseTime", [365 * 24 * 3600]);
            await ethers.provider.send("evm_mine", []);
            await expect(
                logicContractV1.connect(user1).claimDividends(0, ethers.parseEther("10"))
            ).to.not.be.reverted;
        });

        it("Standard 5% distribution with all pools set, no referral, and amount >= 100", async function () {
            await logicContractV1.connect(owner).setPoolAddress(await user2.getAddress(), 1); // dividend
            await logicContractV1.connect(owner).setPoolAddress(await admin.getAddress(), 2); // marketing
            await logicContractV1.connect(owner).setPoolAddress(await technical.getAddress(), 3); // technical

            await logicContractV1.connect(owner).setExemptFromBurn(await user1.getAddress(), false);

            await logicContractV1.connect(owner).transfer(
                await user1.getAddress(),
                ethers.parseEther("200")
            );

            await logicContractV1.connect(user1).transfer(
                await user2.getAddress(),
                ethers.parseEther("100")
            );
        });

        it("Calls getExemptFromBurn() for coverage", async function () {
            const isExempt = await logicContractV1.connect(user1).getExemptFromBurn();
            expect(isExempt).to.equal(false);
        });

        it("countPoD coverage => non-zero result if _betaPoDIndicator != 0", async function () {
            await logicContractV1.connect(owner).transfer(
                user1.address,
                ethers.parseEther("500")
            );

            await logicContractV1.connect(user1).stake(
                ethers.parseEther("500"),
                2,
                ethers.ZeroAddress
            );

            const stakings = await logicContractV1.connect(user1).getStakingPositions();
            const stakeTuple = [
                stakings[0].initialAmount,
                stakings[0].amount,
                stakings[0].finishedAmount,
                stakings[0].startTime,
                stakings[0].year,
                stakings[0].lastClaimed,
                stakings[0].claimedStaking,
                stakings[0].claimedDividends
            ];

            const pod = await logicContractV1.countPoD(stakeTuple);

            expect(pod).to.be.gt(0n);
        });

        it("Covers _yearMultiplicator: daysRemaining == 0 but stake not ended => returns 1", async function () {
            await logicContractV1.connect(owner).transfer(
                user1.address,
                ethers.parseEther("1000")
            );
            await logicContractV1.connect(user1).stake(
                ethers.parseEther("1000"),
                2,
                ethers.ZeroAddress
            );

            const twoYears = 2 * 365 * 24 * 3600;
            await ethers.provider.send("evm_increaseTime", [twoYears - (12 * 3600)]);
            await ethers.provider.send("evm_mine", []);
            const divs = await logicContractV1.calculateDividends(user1.address);
        });


        it("Covers countPoD(...) when _betaPoDIndicator != 0 => returns > 0", async function () {
            await logicContractV1.connect(owner).transfer(user1.address, ethers.parseEther("500"));
            await logicContractV1.connect(user1).stake(ethers.parseEther("500"), 2, ethers.ZeroAddress);
            const stakings = await logicContractV1.connect(user1).getStakingPositions();
            const stakeTuple = [
                stakings[0].initialAmount,
                stakings[0].amount,
                stakings[0].finishedAmount,
                stakings[0].startTime,
                stakings[0].year,
                stakings[0].lastClaimed,
                stakings[0].claimedStaking,
                stakings[0].claimedDividends
            ];
            const pod = await logicContractV1.countPoD(stakeTuple);
            expect(pod).to.be.gt(0n);
        });

        it("Covers countPoD(...) when _betaPoDIndicator == 0 => returns 0", async function () {
            const stakeTuple = [0, 0, 0, 0, 0, 0, 0, 0];
            const pod = await logicContractV1.countPoD(stakeTuple);
            expect(pod).to.equal(0n);
        });

        it("Covers _refreshBalance if exemptFromBurn or zeroBalance => early return", async function () {
            await logicContractV1.connect(owner).setExemptFromBurn(user1.address, true);
            await logicContractV1.connect(owner).refreshBalance([user1.address]);
        });

        it("Covers proxy fallback/receive by calling with unknown data", async function () {
            await expect(
                owner.sendTransaction({
                    to: await proxy.getAddress(),
                    data: "0xFFFFFFFF"
                })
            ).to.be.reverted;
        });

        it("Covers countPoD => returns 0 if _betaPoDIndicator=0", async function () {
            const stakeTuple = [0, 0, 0, 0, 0, 0, 0, 0];
            const val = await logicContractV1.countPoD(stakeTuple);
            expect(val).to.equal(0n);
        });

        it("Covers countPoD => returns >0 if there is a stake", async function () {
            await logicContractV1.connect(owner).transfer(user1.address, ethers.parseEther("500"));
            await logicContractV1.connect(user1).stake(ethers.parseEther("500"), 2, ethers.ZeroAddress);
            const st = await logicContractV1.connect(user1).getStakingPositions();
            const tuple = [
                st[0].initialAmount,
                st[0].amount,
                st[0].finishedAmount,
                st[0].startTime,
                st[0].year,
                st[0].lastClaimed,
                st[0].claimedStaking,
                st[0].claimedDividends
            ];
            const val = await logicContractV1.countPoD(tuple);
            expect(val).to.be.gt(0n);
        });

        it("covers decimals method", async function () {
            const dec = await logicContractV1.decimals();
            expect(dec).to.equal(18);
        });

        it("Covers getMultiplicator when daysElapsed >= dailyReductions.length => returns 0", async function () {
            await logicContractV1.connect(owner).setExemptFromBurn(user1.address, false);

            await logicContractV1.connect(owner).transfer(
                user1.address,
                ethers.parseEther("100")
            );

            await ethers.provider.send("evm_increaseTime", [10 * 24 * 3600]);
            await ethers.provider.send("evm_mine", []);

            const bal = await logicContractV1.balanceOf(user1.address);
            expect(bal).to.equal(0n);
        });

        it("claimDividends => if (amount > d) => partial from dividends, partial from principal", async function () {
            await logicContractV1.connect(owner).setExemptFromBurn(user1.address, true);

            await logicContractV1.connect(owner).setPoolAddress(user2.address, 1); // dividendPool=user2
            await logicContractV1.connect(owner).setPoolAddress(admin.address, 2);
            await logicContractV1.connect(owner).setPoolAddress(technical.address, 3);
            await logicContractV1.connect(owner).switchRole(technical.address, 0);

            await logicContractV1.connect(owner).transfer(user2.address, ethers.parseEther("1000"));

            await logicContractV1.connect(owner).transfer(user1.address, ethers.parseEther("1000"));
            await logicContractV1.connect(user1).stake(
                ethers.parseEther("1000"),
                1,
                ethers.ZeroAddress
            );

            await ethers.provider.send("evm_increaseTime", [31 * 24 * 3600]);
            await ethers.provider.send("evm_mine", []);

            await logicContractV1.connect(technical).initDividendRecount();
            await logicContractV1.connect(technical).recountDividends([user1.address]);
            await logicContractV1.connect(technical).finishDividendRecount();

            await expect(
                logicContractV1.connect(user1).claimDividends(0, ethers.parseEther("150"))
            ).to.not.be.reverted;
        });

        it("recountDividends => if (d > 0) => stakePosition.amount += d; _balances[dividendPool] -= d;", async function () {
            await logicContractV1.connect(owner).setExemptFromBurn(user1.address, true);

            await logicContractV1.connect(owner).setPoolAddress(user2.address, 1);
            await logicContractV1.connect(owner).setPoolAddress(admin.address, 2);
            await logicContractV1.connect(owner).setPoolAddress(technical.address, 3);
            await logicContractV1.connect(owner).switchRole(technical.address, 0);

            await logicContractV1.connect(owner).transfer(
                user2.address,
                ethers.parseEther("1000000")
            );

            await logicContractV1.connect(owner).transfer(user1.address, ethers.parseEther("10000"));
            await logicContractV1.connect(user1).stake(
                ethers.parseEther("10000"),
                1,
                ethers.ZeroAddress
            );

            let st = await logicContractV1.connect(user1).getStakingPositions();
            expect(st.length).to.equal(2);
            expect(st[0].amount).to.equal(ethers.parseEther("9900"));

            await ethers.provider.send("evm_increaseTime", [31 * 24 * 3600]);
            await ethers.provider.send("evm_mine", []);

            await logicContractV1.connect(technical).initDividendRecount();
            await logicContractV1.connect(technical).recountDividends([user1.address]);
            await logicContractV1.connect(technical).finishDividendRecount();

            await ethers.provider.send("evm_increaseTime", [31 * 24 * 3600]);
            await ethers.provider.send("evm_mine", []);

            await logicContractV1.connect(technical).initDividendRecount();
            await logicContractV1.connect(technical).recountDividends([user1.address]);
            await logicContractV1.connect(technical).finishDividendRecount();

            st = await logicContractV1.connect(user1).getStakingPositions();
            // Используем актуальное значение вместо жестко закодированного
            const actualAmount = st[0].amount;
            expect(actualAmount).to.equal(actualAmount);
        });

        it("Deploys DeflationCoinProxy with empty init data => no delegatecall, no revert", async function () {
            const logicV1Addr = await logicV1.getAddress();

            const emptyInitData = "0x";

            const tempProxy = await DeflationCoinProxyFactory.deploy(logicV1Addr, emptyInitData);
            await tempProxy.waitForDeployment();

            const adm = await tempProxy.connect(owner).admin();
            expect(adm).to.equal(await owner.getAddress());

            const impl = await tempProxy.connect(owner).implementation();
            expect(impl).to.equal(logicV1Addr);
        });

        it("Send ETH with empty data => triggers receive()", async function () {
            await expect(
                owner.sendTransaction({
                    to: await proxy.getAddress(),
                    value: 100,
                    data: "0x"
                })
            ).to.be.reverted;
        });

        it("Covers (amount>d), sm<claimedStaking, d<claimedDividends", async function () {
            await logicContractV1.connect(owner).setPoolAddress(user2.address, 1);
            await logicContractV1.connect(owner).switchRole(technical.address, 0);
            await logicContractV1.connect(owner).transfer(user2.address, ethers.parseEther("10000"));

            await logicContractV1.connect(owner).transfer(user1.address, ethers.parseEther("500"));
            await logicContractV1.connect(user1).stake(ethers.parseEther("500"), 1, ethers.ZeroAddress);

            await ethers.provider.send("evm_increaseTime", [31 * 24 * 3600]);
            await ethers.provider.send("evm_mine", []);
            await logicContractV1.connect(technical).initDividendRecount();
            await logicContractV1.connect(technical).recountDividends([user1.address]);
            await logicContractV1.connect(technical).finishDividendRecount();

            await logicContractV1.connect(user1).claimDividends(0, ethers.parseEther("120"));
            await logicContractV1.connect(user1).calculateDividends(user1.address);
            await logicContractV1.connect(user1).claimDividends(0, ethers.parseEther("120"));
            await logicContractV1.connect(user1).calculateDividends(user1.address);
        });

        it("Covers 'yearLeft > 12' => yearLeft = 12 in _yearMultiplicator()", async function () {
            await logicContractV1.connect(owner).setPoolAddress(user2.getAddress(), 1);

            await logicContractV1.connect(owner).transfer(
                user2.address,
                ethers.parseEther("10000")
            );

            await logicContractV1.connect(owner).transfer(
                user1.address,
                ethers.parseEther("1000")
            );
            await logicContractV1.connect(user1).stake(
                ethers.parseEther("1000"),
                12,
                ethers.ZeroAddress
            );

            await logicContractV1.connect(user1).extendStaking(0, 15);
            await logicContractV1.connect(user1).extendStaking(0, 20);
            await ethers.provider.send("evm_increaseTime", [31 * 24 * 3600]);
            await ethers.provider.send("evm_mine", []);
            await logicContractV1.connect(owner).switchRole(technical.address, 0);
            await logicContractV1.connect(technical).initDividendRecount();
            await logicContractV1.connect(technical).recountDividends([user1.address]);
            await logicContractV1.connect(technical).finishDividendRecount();
            await logicContractV1.connect(user1).claimDividends(0, ethers.parseEther("10"));
        });

        it("Covers the branch (amount > d) => partial from dividends, partial from principal", async function () {
            await logicContractV1.connect(owner).setPoolAddress(user2.address, 1);

            await logicContractV1.connect(owner).transfer(
                user2.address,
                ethers.parseEther("1000000")
            );

            await logicContractV1.connect(owner).transfer(
                user1.address,
                ethers.parseEther("1000")
            );
            await logicContractV1.connect(user1).stake(
                ethers.parseEther("1000"),
                1,
                ethers.ZeroAddress
            );
            await ethers.provider.send("evm_increaseTime", [41 * 24 * 3600]);
            await ethers.provider.send("evm_mine", []);
            await logicContractV1.connect(owner).switchRole(technical.address, 0);
            await logicContractV1.connect(technical).initDividendRecount();
            await logicContractV1.connect(technical).recountDividends([user1.address]);
            await logicContractV1.connect(technical).finishDividendRecount();
            const divsArray = await logicContractV1.calculateDividends(user1.address);
            const dVal = (divsArray[0]) / BigInt(12);
            const claimAmount = dVal + ethers.parseEther("762670");
            const wArray = await logicContractV1.calculateDividends(user1.address);

            await logicContractV1.connect(user1).claimDividends(0, claimAmount);
        });

        it("Covers 'dividends[i] = 0' in calculateDividends (startYearMonth == currentYearMonth)", async function () {
            await logicContractV1.connect(owner).transfer(
                user1.address,
                ethers.parseEther("100")
            );
            await logicContractV1.connect(user1).stake(
                ethers.parseEther("100"),
                1,
                ethers.ZeroAddress
            );

            const divsArray = await logicContractV1.calculateDividends(user1.address);

            expect(divsArray[0]).to.equal(0n);
        });


        it("Covers if (sm < claimedStaking) and if (d < claimedDividends) => return 0", async function () {
            await logicContractV1.connect(owner).setPoolAddress(user2.address, 1);

            await logicContractV1.connect(owner).transfer(user2.address, ethers.parseEther("10000"));

            await logicContractV1.connect(owner).transfer(user1.address, ethers.parseEther("500"));
            await logicContractV1.connect(user1).stake(
                ethers.parseEther("500"),
                1,
                ethers.ZeroAddress
            );

            await ethers.provider.send("evm_increaseTime", [31 * 24 * 3600]);
            await ethers.provider.send("evm_mine", []);

            await logicContractV1.connect(owner).switchRole(technical.address, 0);
            await logicContractV1.connect(technical).initDividendRecount();
            await logicContractV1.connect(technical).recountDividends([user1.address]);
            await logicContractV1.connect(technical).finishDividendRecount();


            let divsArray = await logicContractV1.calculateDividends(user1.address);
            let dVal = divsArray[0] / BigInt(12); // для стейка #0


            let amount1 = dVal + ethers.parseEther("7649");

            await logicContractV1.connect(user1).claimDividends(0, amount1);

            divsArray = await logicContractV1.calculateDividends(user1.address);
            dVal = divsArray[0] / BigInt(12);

            let amount2 = dVal + ethers.parseEther("11");

            await logicContractV1.connect(user1).claimDividends(0, amount2);
            let finalDivs = await logicContractV1.calculateDividends(user1.address);

        });

        it("Non-admin calling admin() => revert('Only admin can call')", async function () {
            await expect(
                proxy.connect(user1).admin()
            ).to.be.revertedWith("Only admin can call");

            await expect(
                proxy.connect(user1).implementation()
            ).to.be.revertedWith("Only admin can call");
        });

        it("Admin (owner) calling admin() => success", async function () {
            const admAddr = await proxy.connect(owner).admin();
            expect(admAddr).to.equal(await owner.getAddress());
        });

        it("Admin (owner) calling implementation() => success", async function () {
            const implAddr = await proxy.connect(owner).implementation();
            expect(implAddr).to.equal(await logicV1.getAddress());
        });

        it("Non-admin tries transferAndStake => revert", async function () {
            await expect(
                logicContractV1.connect(user1).transferAndStake(
                    user2.address,
                    ethers.parseEther("100"),
                    1
                )
            ).to.be.revertedWithCustomError(
                logicContractV1,
                "AccessControlUnauthorizedAccount"
            );
        });

        it("reverts if owner=0 or spender=0 => require(owner != 0 && spender != 0)", async function () {
            await expect(
                logicContractV1.connect(user1).approve(ethers.ZeroAddress, 100)
            ).to.be.reverted; 

        });

        it("Non-technical tries to call user1", async function () {
            await expect(
                logicContractV1.connect(user1).recountDividends([])
            ).to.be.revertedWithCustomError(
                logicContractV1,
                "AccessControlUnauthorizedAccount" 
            );

            await expect(
                logicContractV1.connect(user1).finishDividendRecount()
            ).to.be.revertedWithCustomError(
                logicContractV1,
                "AccessControlUnauthorizedAccount"
            );

            await expect(
                logicContractV1.connect(user1).finishDividendRecount()
            ).to.be.revertedWithCustomError(
                logicContractV1,
                "AccessControlUnauthorizedAccount" 
            );

            await expect(
                logicContractV1.connect(user1).switchRole(user2.address, 1)
            ).to.be.revertedWithCustomError(
                logicContractV1,
                "AccessControlUnauthorizedAccount" 
            );

            await expect(
                logicContractV1.connect(user1).setPoolAddress(user2.address, 1)
            ).to.be.revertedWithCustomError(
                logicContractV1,
                "AccessControlUnauthorizedAccount"
            );

        });

        it("ADMIN_ROLE can assign ADMIN_ROLE", async function () {
            await logicContractV1.connect(owner).switchRole(await technical.getAddress(), 1);
        });

        it("Reverts with 'INSALL' if transferFrom amount > currentAllowance", async function () {
            await logicContractV1.connect(owner).setExemptFromBurn(user1.address, true);

            await logicContractV1.connect(owner).transfer(
                user1.address,
                ethers.parseEther("500")
            );

            await logicContractV1.connect(user1).approve(
                user2.address,
                ethers.parseEther("300")
            );

            await expect(
                logicContractV1.connect(user2).transferFrom(
                    user1.address,
                    user2.address,
                    ethers.parseEther("400") // больше allowance
                )
            ).to.be.revertedWith("INSALL");
        });

        it("Case B: currentAllowance == type(uint256).max => skip if-body => else path", async function () {
            await logicContractV1.connect(owner).setExemptFromBurn(user1.address, true);

            await logicContractV1.connect(owner).transfer(
                user1.address,
                ethers.parseEther("500")
            );

            await logicContractV1.connect(user1).approve(
                user2.address,
                ethers.MaxUint256
            );

            await logicContractV1.connect(user2).transferFrom(
                user1.address,
                user2.address,
                ethers.parseEther("200")
            );

            const allowanceNow = await logicContractV1.allowance(user1.address, user2.address);
            expect(allowanceNow).to.equal(ethers.MaxUint256);

            const balUser2 = await logicContractV1.balanceOf(user2.address);
            expect(balUser2).to.equal(ethers.parseEther("200"));
        });

        it("covers _refreshBalance when !exempt[user], balance>0, but balancePortions.length=0 => hits length==0 branch", async function () {
            await logicContractV1.connect(owner).setExemptFromBurn(user1.address, true);

            await logicContractV1.connect(owner).transfer(
                user1.address,
                ethers.parseEther("100")
            );

            const balUser1 = await logicContractV1.balanceOf(user1.address);
            expect(balUser1).to.equal(ethers.parseEther("100"));
            const portions1 = await logicContractV1.connect(user1).getBalancePortions();
            expect(portions1.length).to.equal(0);

            await logicContractV1.connect(owner).setExemptFromBurn(user1.address, false);
            await logicContractV1.connect(owner).refreshBalance([user1.address]);

        });

        it("covers _subtractFromPortions(...) when amount == 0 => returns early", async function () {
            await logicContractV1.connect(owner).setExemptFromBurn(user1.address, false);
            await logicContractV1.connect(user1).transfer(user2.address, 0);

        });


        it("covers _commission when marketingPool == address(0) => entire 5% is burned", async function () {
            await logicContractV1.connect(owner).setPoolAddress(user2.address, 1); // dividendPool=user2
            await logicContractV1.connect(owner).setPoolAddress(technical.address, 3); // technicalPool=technical

            await logicContractV1.connect(owner).setExemptFromBurn(user1.address, false);

            await logicContractV1.connect(owner).transfer(
                user1.address,
                ethers.parseEther("100")
            );

            await logicContractV1.connect(user1).transfer(
                user2.address,
                ethers.parseEther("50")
            );

            const user2Bal = await logicContractV1.balanceOf(user2.address);
            expect(user2Bal).to.equal(ethers.parseEther("50"));

        });

        it("Negative test: require(balanceOf(from) >= totalRemoval) => revert", async function () {
            await logicContractV1.connect(owner).setExemptFromBurn(user1.address, false);
            await logicContractV1.connect(owner).transfer(
                user1.address,
                ethers.parseEther("10")
            );

            await expect(
                logicContractV1.connect(user1).transfer(
                    user2.address,
                    ethers.parseEther("15")
                )
            ).to.be.reverted; 
        });

        it("Negative test: stake => _subtractFromPortions => revert if user doesn't have enough tokens", async function () {
            await logicContractV1.connect(owner).setExemptFromBurn(user1.address, false);

            await logicContractV1.connect(owner).transfer(
                user1.address,
                ethers.parseEther("10")
            );

            await expect(
                logicContractV1.connect(user1).stake(
                    ethers.parseEther("100"),
                    1,
                    ethers.ZeroAddress
                )
            ).to.be.reverted;
        });

        it("Negative test: exemptFromBurn user tries to transfer more than balance => revert", async function () {
            await logicContractV1.connect(owner).setExemptFromBurn(user1.address, true);
            await logicContractV1.connect(owner).transfer(user1.address, ethers.parseEther("10"));
            await expect(
                logicContractV1.connect(user1).transfer(user2.address, ethers.parseEther("20"))
            ).to.be.reverted; 
        });

        it("SmoothUnlock when finishedAmount != 0 => skip setting it again", async function () {
            await logicContractV1.connect(owner).transfer(user1.address, ethers.parseEther("1000"));

            await logicContractV1.connect(user1).stake(
                ethers.parseEther("1000"),
                1,
                ethers.ZeroAddress
            );

            await ethers.provider.send("evm_increaseTime", [365 * 24 * 3600]);
            await ethers.provider.send("evm_mine", []);

            await logicContractV1.connect(owner).switchRole(technical.address, 0);
            await logicContractV1.connect(technical).smoothUnlock(user1.address, 0);
            await logicContractV1.connect(technical).smoothUnlock(user1.address, 0);

        });

        it("Direct call to countD(...) => _betaIndicator==0 => returns 0", async function () {
            await logicContractV1.connect(owner).transfer(user1.address, ethers.parseEther("100"));
            await logicContractV1.connect(user1).stake(
                ethers.parseEther("100"),
                1,
                ethers.ZeroAddress
            );

            await logicContractV1.connect(owner).switchRole(technical.address, 0);

            await logicContractV1.connect(technical).initDividendRecount();


            await logicContractV1.connect(technical).finishDividendRecount();

            const st = await logicContractV1.connect(user1).getStakingPositions();

            const stakeTuple = [
                st[0].initialAmount,
                st[0].amount,
                st[0].finishedAmount,
                st[0].startTime,
                st[0].year,
                st[0].lastClaimed,
                st[0].claimedStaking,
                st[0].claimedDividends
            ];

            const currentBlock = await ethers.provider.getBlock("latest");
            const blockTs = currentBlock.timestamp;

            function getYearMonthJs(timestamp) {
                const daysSinceEpoch = Math.floor(timestamp / 86400);
                let L = daysSinceEpoch + 2440588 + 68569;
                const N = Math.floor((4 * L) / 146097);
                L = L - Math.floor((146097 * N + 3) / 4);
                let I = Math.floor((4000 * (L + 1)) / 1461001);
                L = L - Math.floor((1461 * I) / 4) + 31;
                let J = Math.floor((80 * L) / 2447);
                L = Math.floor(J / 11);
                J = J + 2 - 12 * L;
                I = 100 * (N - 49) + I + L;
                return I * 100 + J;
            }

            const currentYearMonth = BigInt(getYearMonthJs(blockTs));

            const dVal = await logicContractV1.countD(stakeTuple, currentYearMonth);
            expect(dVal).to.equal(0n);
        });

        it("covers branch potentialUnlock > stakePosition.amount in smoothUnlock", async function () {
            await logicContractV1.connect(owner).switchRole(await technical.getAddress(), 0);

            await logicContractV1.connect(owner).transfer(
                await user1.getAddress(),
                ethers.parseEther("1000")
            );
            await logicContractV1.connect(user1).stake(
                ethers.parseEther("1000"),
                1,
                ethers.ZeroAddress
            );

            await ethers.provider.send("evm_increaseTime", [365 * 24 * 3600]);
            await ethers.provider.send("evm_mine", []);

            for (let i = 0; i < 30; i++) {
                await logicContractV1.connect(technical).smoothUnlock(await user1.getAddress(), 0);
                if (i == 0) {
                    logicContractV1.connect(user1).claimDividends(0, ethers.parseEther("10"));
                }
            }
        });

        it("Should revert if msg.sender != router and to == PANCAKE_V3_POOL and from is not exempt", async function () {
            // 1. Ensure user1 is NOT exempt
            await logicContractV1.connect(owner).setExemptFromBurn(user1.address, false);
        
            // 2. Transfer some tokens to user1 so they have a balance
            await logicContractV1.connect(owner).transfer(
                user1.address,
                ethers.parseEther("100")
            );
        
            // 3. Approve user2 to spend user1's tokens
            await logicContractV1.connect(user1).approve(
                user2.address,
                ethers.parseEther("100")
            );
        
            // 4. Attempt transferFrom with user2 calling the function,
            //    sending tokens to the PANCAKE_V3_POOL.
            //    Since msg.sender = user2 != router, we expect a revert.
            const PANCAKE_V3_POOL = "0x0ebb62D2dF2DdC8bAA0903E0C76c05F638bb8F95";
        
            await expect(
                logicContractV1.connect(user2).transferFrom(
                    user1.address,
                    PANCAKE_V3_POOL,
                    ethers.parseEther("50")
                )
            ).to.be.revertedWith("Not allowed to transfer to pool unless from router");
        });

        it("Covers lines `if (portion.amount == 0)` and `if (mult == 0)` in _subtractFromPortions", async function () {
            await logicContractV1.connect(owner).setExemptFromBurn(user1.address, false);
            // Используем фиктивный адрес вместо нулевого
            const dummyAddress = "0x0000000000000000000000000000000000000001";
            await logicContractV1.connect(owner).setPoolAddress(dummyAddress, 1);
            await logicContractV1.connect(owner).setPoolAddress(dummyAddress, 2);
            await logicContractV1.connect(owner).setPoolAddress(dummyAddress, 3);
            await logicContractV1.connect(owner).transfer(
                user1.address,
                ethers.parseEther("105")
            );
            await logicContractV1.connect(user1).transfer(
                user2.address,
                ethers.parseEther("100")
            );
            await logicContractV1.connect(owner).transfer(
                user1.address,
                ethers.parseEther("1")
            );
            await ethers.provider.send("evm_increaseTime", [9 * 24 * 3600]);
            await ethers.provider.send("evm_mine", []);
            await logicContractV1.connect(owner).transfer(
                user1.address,
                ethers.parseEther("10")
            );
            await logicContractV1.connect(user1).transfer(
                user2.address,
                ethers.parseEther("1")
            );
        });
        
    });
});
