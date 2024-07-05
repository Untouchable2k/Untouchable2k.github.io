// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ConfirmedOwner} from "@chainlink/contracts@1.1.1/src/v0.8/shared/access/ConfirmedOwner.sol";
import {VRFV2WrapperConsumerBase} from "@chainlink/contracts@1.1.1/src/v0.8/vrf/VRFV2WrapperConsumerBase.sol";
import {LinkTokenInterface} from "@chainlink/contracts@1.1.1/src/v0.8/shared/interfaces/LinkTokenInterface.sol";

contract bnbtcLottery is VRFV2WrapperConsumerBase, ConfirmedOwner {
    event RequestSent(uint256 requestId, uint32 numWords);
    event RequestFulfilled(uint256 requestId, uint256[] randomWords, uint256 payment);
    event TicketPurchased(address indexed buyer, uint32 ticketNumber, uint256 roundId);
    event Winner(address indexed winner, uint256 roundId, uint256 amount);
    event WinnerSelected(address indexed winner, uint32 ticketNumber, uint256 roundId);

    struct RequestStatus {
        uint256 paid; // amount paid in link
        bool fulfilled; // whether the request has been successfully fulfilled
        uint256[] randomWords;
    }

    struct Round {
        uint256 maxTickets;
        uint256 soldTickets;
        uint256 ticketPrice;
        uint256 winnerReward;
        uint256 deployerReward;
        uint256 donationAmount;
        address winnerAddress;
        uint256 winnerRewardPercentage;
        uint256 deployerRewardPercentage;
        mapping(uint32 => address) ticketOwners;
    }

    struct NextRoundSettings {
        bool maxTicketsSet;
        bool ticketPriceSet;
        bool rewardPercentagesSet;
        uint256 maxTickets;
        uint256 ticketPrice;
        uint256 winnerRewardPercentage;
        uint256 deployerRewardPercentage;
    }

    uint32 private callbackGasLimit = 500000;
    uint16 private requestConfirmations = 3;
    uint32 private numWords = 1;
    address private linkAddress = 0x84b9B910527Ad5C03A9Ca831909E21e236EA7b06; // BNBTC testnet LINK address
    address private wrapperAddress = 0x699d428ee890d55D56d5FC6e26290f3247A762bd; // BNBTC testnet VRF Wrapper address

    mapping(uint256 => RequestStatus) public s_requests;
    mapping(uint256 => Round) public rounds;
    mapping(uint256 => address) public roundWinners;
    mapping(uint256 => uint32) public roundWinningTickets;
    mapping(uint256 => bool) public roundRewardsDistributed;
    mapping(address => uint256) public claimedTo;

    uint256[] public requestIds;
    uint256 public lastRequestId;
    uint256 public currentRound;

    NextRoundSettings public nextRoundSettings;
    address payable public deployer;
    IERC20 public acceptedToken;
    address public donationAddress;

    constructor(
        uint256 _maxTickets,
        uint256 _ticketPrice,
        uint256 _winnerRewardPercentage,
        uint256 _deployerRewardPercentage
    ) 
        ConfirmedOwner(msg.sender)
        VRFV2WrapperConsumerBase(linkAddress, wrapperAddress)
    {
        deployer = payable(msg.sender);
        acceptedToken = IERC20(0x59984dBdda327dAF68285a896ACe398A739F80c3);
        donationAddress = 0xB311127Cda9AfA828CDA41E036E681050e81cf77;

        Round storage round = rounds[currentRound];
        round.maxTickets = _maxTickets;
        round.ticketPrice = _ticketPrice;
        round.winnerRewardPercentage = _winnerRewardPercentage;
        round.deployerRewardPercentage = _deployerRewardPercentage;
    }

    function requestRandomWords() internal returns (uint256 requestId) {
        requestId = requestRandomness(callbackGasLimit, requestConfirmations, numWords);
        s_requests[requestId] = RequestStatus({
            paid: VRF_V2_WRAPPER.calculateRequestPrice(callbackGasLimit),
            randomWords: new uint256[](0),
            fulfilled: false
        });
        requestIds.push(requestId);
        lastRequestId = requestId;
        emit RequestSent(requestId, numWords);
        return requestId;
    }

     function fulfillRandomWords(uint256 _requestId, uint256[] memory _randomWords) internal override {
        require(s_requests[_requestId].paid > 0, "request not found");
        s_requests[_requestId].fulfilled = true;
        s_requests[_requestId].randomWords = _randomWords;
        emit RequestFulfilled(_requestId, _randomWords, s_requests[_requestId].paid);

        Round storage round = rounds[currentRound];
        uint32 winningTicket = uint32((_randomWords[0] % round.maxTickets) + 1); // Generate number between 1 and round.maxTickets

        address winner = round.ticketOwners[winningTicket];
        round.winnerAddress = winner;
        round.winnerReward = (round.ticketPrice * round.maxTickets * round.winnerRewardPercentage) / 100;
        round.deployerReward = (round.ticketPrice * round.maxTickets * round.deployerRewardPercentage) / 100;

        round.donationAmount = (round.ticketPrice * round.maxTickets) - (round.winnerReward + round.deployerReward);

        emit WinnerSelected(winner, winningTicket, currentRound);
        roundWinners[currentRound] = winner;
        roundWinningTickets[currentRound] = winningTicket;

        currentRound++;
        setNextRoundSettings(round);
        delete nextRoundSettings;
    }
        

    function getRequestStatus(uint256 _requestId) external view returns (uint256 paid, bool fulfilled, uint256[] memory randomWords) {
        require(s_requests[_requestId].paid > 0, "request not found");
        RequestStatus memory request = s_requests[_requestId];
        return (request.paid, request.fulfilled, request.randomWords);
    }

    function withdrawLink() public onlyOwner {
        LinkTokenInterface link = LinkTokenInterface(linkAddress);
        require(link.transfer(msg.sender, link.balanceOf(address(this))), "Unable to transfer");
    }

    function setMaxTicketsForNextRound(uint256 _maxTickets) public {
        require(msg.sender == deployer, "Only the deployer can change the max tickets");
        nextRoundSettings.maxTickets = _maxTickets;
        nextRoundSettings.maxTicketsSet = true;
    }

    function setTicketPriceForNextRound(uint256 _ticketPrice) public {
        require(msg.sender == deployer, "Only the deployer can change the ticket price");
        nextRoundSettings.ticketPrice = _ticketPrice;
        nextRoundSettings.ticketPriceSet = true;
    }

    function setFutureRewardPercentages(uint256 _futureWinnerRewardPercentage, uint256 _futureDeployerRewardPercentage) external {
        require(msg.sender == deployer, "Only the deployer can change the future reward percentages");
        nextRoundSettings.winnerRewardPercentage = _futureWinnerRewardPercentage;
        nextRoundSettings.deployerRewardPercentage = _futureDeployerRewardPercentage;
        nextRoundSettings.rewardPercentagesSet = true;
    }

    function buyTickets(uint256 numTickets) public {
        Round storage round = rounds[currentRound];
        require(round.soldTickets < round.maxTickets, "All tickets for this round are sold");

        uint256 remainingTickets = round.maxTickets - round.soldTickets;
        if (numTickets > remainingTickets) {
            numTickets = remainingTickets;
        }

        uint256 totalCost = round.ticketPrice * numTickets;
        acceptedToken.transferFrom(msg.sender, address(this), totalCost);

        for (uint256 i = 0; i < numTickets; i++) {
            round.ticketOwners[uint32(round.soldTickets + 1)] = msg.sender;
            round.soldTickets++;
        }

        emit TicketPurchased(msg.sender, uint32(round.soldTickets), currentRound);

        if (round.soldTickets == round.maxTickets) {
            requestRandomWords();
        }
    }
    /*

    function selectWinner() private {
        Round storage round = rounds[currentRound];
        uint32 winningTicket = uint32(_pseudoRandomNumber(round.maxTickets));
        address winner = round.ticketOwners[winningTicket];
        round.winnerAddress = winner;
        round.winnerReward = (round.ticketPrice * round.maxTickets * round.winnerRewardPercentage) / 100;
        round.deployerReward = (round.ticketPrice * round.maxTickets * round.deployerRewardPercentage) / 100;

        round.donationAmount = (round.ticketPrice * round.maxTickets) - (round.winnerReward + round.deployerReward);

        emit WinnerSelected(winner, winningTicket, currentRound);
        roundWinners[currentRound] = winner;
        roundWinningTickets[currentRound] = winningTicket;

        currentRound++;
        setNextRoundSettings(round);
        delete nextRoundSettings;
    }
    */

    function setNextRoundSettings(Round storage round) private {
        if (nextRoundSettings.maxTicketsSet) {
            rounds[currentRound].maxTickets = nextRoundSettings.maxTickets;
        } else {
            rounds[currentRound].maxTickets = round.maxTickets;
        }
        if (nextRoundSettings.ticketPriceSet) {
            rounds[currentRound].ticketPrice = nextRoundSettings.ticketPrice;
        } else {
            rounds[currentRound].ticketPrice = round.ticketPrice;
        }
        if (nextRoundSettings.rewardPercentagesSet) {
            rounds[currentRound].winnerRewardPercentage = nextRoundSettings.winnerRewardPercentage;
            rounds[currentRound].deployerRewardPercentage = nextRoundSettings.deployerRewardPercentage;
        } else {
            rounds[currentRound].winnerRewardPercentage = round.winnerRewardPercentage;
            rounds[currentRound].deployerRewardPercentage = round.deployerRewardPercentage;
        }
    }

    function withdrawReward(uint256 roundId) public {
        require(!roundRewardsDistributed[roundId], "Reward already distributed");
        Round storage round = rounds[roundId];
        require(msg.sender == round.winnerAddress, "Only the winner can withdraw the reward");

        acceptedToken.transfer(round.winnerAddress, round.winnerReward);
        acceptedToken.transfer(deployer, round.deployerReward);

        if (round.donationAmount > 0) {
            acceptedToken.transfer(donationAddress, round.donationAmount);
        }

        emit Winner(round.winnerAddress, roundId, round.winnerReward);
        roundRewardsDistributed[roundId] = true;
    }

    function smartClaim() public {
        uint256[] memory totalRounds = getArrayOfRoundsWinnersUnclaimed(msg.sender);
        withdrawRewardMultiArray(totalRounds);
        claimedTo[msg.sender] = currentRound - 1;
    }

    function setClaimedTo(uint256 RoundNumber) public {
        claimedTo[msg.sender] = RoundNumber;
    }

    function smartClaimTotalAmount(address user) public view returns (uint256 Reward) {
        uint256[] memory totalRounds = getArrayOfRoundsWinnersUnclaimed(user);
        uint256 totalToReceive = 0;
        for (uint256 x = 0; x < totalRounds.length; x++) {
            Round storage round = rounds[totalRounds[x]];
            if (!roundRewardsDistributed[totalRounds[x]] && user == round.winnerAddress) {
                totalToReceive += round.winnerReward;
            }
        }
        return totalToReceive;
    }

    function getArrayOfRoundsWinnersAlreadyClaimed(address user) public view returns (uint256[] memory) {
        uint256 start = 0;
        uint256 count = 0;
        uint256[] memory winDays = new uint256[](currentRound - start + 1);
        for (uint256 x = start; x <= currentRound; x++) {
            Round storage round = rounds[x];
            if (roundRewardsDistributed[x] && user == round.winnerAddress) {
                winDays[count] = x;
                count++;
            }
        }
        uint256[] memory winDays2 = new uint256[](count);
        for (uint256 x = 0; x < count; x++) {
            winDays2[x] = winDays[x];
        }
        return winDays2;
    }

    function getArrayOfRoundsWinnersUnclaimed(address user) public view returns (uint256[] memory) {
        uint256 start = claimedTo[user];
        uint256 count = 0;
        uint256[] memory winDays = new uint256[](currentRound - start + 1);
        for (uint256 x = start; x <= currentRound; x++) {
            Round storage round = rounds[x];
            if (!roundRewardsDistributed[x] && user == round.winnerAddress) {
                winDays[count] = x;
                count++;
            }
        }
        uint256[] memory winDays2 = new uint256[](count);
        for (uint256 x = 0; x < count; x++) {
            winDays2[x] = winDays[x];
        }
        return winDays2;
    }

    function withdrawRewardMultiArray(uint256[] memory roundIds) public {
        uint256 totalToReceive = 0;
        uint256 deployerToReceive = 0;
        uint256 donation = 0;
        for (uint256 x = 0; x < roundIds.length; x++) {
            Round storage round = rounds[roundIds[x]];
            if (!roundRewardsDistributed[roundIds[x]] && msg.sender == round.winnerAddress) {
                totalToReceive += round.winnerReward;
                deployerToReceive += round.deployerReward;
                donation += round.donationAmount;
                roundRewardsDistributed[roundIds[x]] = true;
                emit Winner(round.winnerAddress, x, round.winnerReward);
            }
        }

        acceptedToken.transfer(msg.sender, totalToReceive);
        acceptedToken.transfer(deployer, deployerToReceive);

        if (donation > 0) {
            acceptedToken.transfer(donationAddress, donation);
        }
    }

    function withdrawRewardForWinner(uint256 roundId) public {
        require(msg.sender == deployer, "Only the deployer can trigger a payout");
        require(!roundRewardsDistributed[roundId], "Reward already distributed");

        Round storage round = rounds[roundId];
        acceptedToken.transfer(round.winnerAddress, round.winnerReward);
        acceptedToken.transfer(deployer, round.deployerReward);

        if (round.donationAmount > 0) {
            acceptedToken.transfer(donationAddress, round.donationAmount);
        }

        emit Winner(round.winnerAddress, roundId, round.winnerReward);
        roundRewardsDistributed[roundId] = true;
    }

    function withdrawRewardForAllPendingWinners() public {
        require(msg.sender == deployer, "Only the deployer can trigger payouts");

        for (uint256 i = 0; i < currentRound; i++) {
            if (!roundRewardsDistributed[i]) {
                withdrawRewardForWinner(i);
            }
        }
    }

    function getTicketsOfBuyerForRound(address buyer, uint256 round) public view returns (uint32[] memory) {
        require(round <= currentRound, "Round not finished yet");
        Round storage r = rounds[round];
        uint32[] memory tickets = new uint32[](r.soldTickets);
        uint32 counter = 0;
        for (uint32 i = 1; i <= r.soldTickets; i++) {
            if (r.ticketOwners[i] == buyer) {
                tickets[counter] = i;
                counter++;
            }
        }
        uint32[] memory result = new uint32[](counter);
        for (uint32 i = 0; i < counter; i++) {
            result[i] = tickets[i];
        }
        return result;
    }

    function getTicketsOfBuyer(address buyer) public view returns (uint256[] memory, uint32[][] memory) {
        uint256[] memory roundsArray = new uint256[](currentRound);
        uint32[][] memory ticketsArray = new uint32[][](currentRound);

        for (uint256 i = 0; i < currentRound; i++) {
            roundsArray[i] = i;
            Round storage r = rounds[i];
            uint32[] memory tickets = new uint32[](r.soldTickets);
            uint32 counter = 0;
            for (uint32 j = 1; j <= r.soldTickets; j++) {
                if (r.ticketOwners[j] == buyer) {
                    tickets[counter] = j;
                    counter++;
                }
            }
            uint32[] memory result = new uint32[](counter);
            for (uint32 j = 0; j < counter; j++) {
                result[j] = tickets[j];
            }
            ticketsArray[i] = result;
        }

        return (roundsArray, ticketsArray);
    }

    function getWinners() public view returns (address[] memory winners, uint32[] memory tickets, bool[] memory rewardsDistributed) {
        winners = new address[](currentRound);
        tickets = new uint32[](currentRound);
        rewardsDistributed = new bool[](currentRound);
        for (uint256 i = 0; i < currentRound; i++) {
            winners[i] = roundWinners[i];
            tickets[i] = roundWinningTickets[i];
            rewardsDistributed[i] = roundRewardsDistributed[i];
        }
    }

    function _pseudoRandomNumber(uint256 max) private view returns (uint256) {
        return (uint256(keccak256(abi.encodePacked(block.timestamp, block.prevrandao, msg.sender))) % max) + 1;
    }
}
