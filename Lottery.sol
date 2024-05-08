// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract Lottery {
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

    NextRoundSettings nextRoundSettings;	
    
    mapping(address => uint256) public claimedTo;

    uint256 public currentRound;
    address payable public deployer;
    IERC20 public acceptedToken;

    mapping(uint256 => Round) public rounds;
    mapping(uint256 => address) public roundWinners;
    mapping(uint256 => uint32) public roundWinningTickets;
    mapping(uint256 => bool) public roundRewardsDistributed;

    event TicketPurchased(address indexed buyer, uint32 ticketNumber, uint256 roundId);
    event Winner(address indexed winner, uint256 roundId, uint256 amount);
    event WinnerSelected(address indexed winner, uint32 ticketNumber, uint256 roundId);

    address public donationAddress;

    constructor(
        uint256 _maxTickets,
        uint256 _ticketPrice,
        address _acceptedToken,
        uint256 _winnerRewardPercentage,
        uint256 _deployerRewardPercentage,
        address _donationAddress
    ) {
        deployer = payable(msg.sender);
        acceptedToken = IERC20(_acceptedToken);
        donationAddress = _donationAddress;

        Round storage round = rounds[currentRound];
        round.maxTickets = _maxTickets;
        round.ticketPrice = _ticketPrice;
        round.winnerRewardPercentage = _winnerRewardPercentage;
        round.deployerRewardPercentage = _deployerRewardPercentage;
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
            selectWinner();
        }
    }

    function selectWinner() private {
        Round storage round = rounds[currentRound];
        uint32 winningTicket = uint32(_pseudoRandomNumber(round.maxTickets));
        address winner = round.ticketOwners[winningTicket];
        round.winnerAddress = winner;
        round.winnerReward = (round.ticketPrice * round.maxTickets * round.winnerRewardPercentage) / 100;
        round.deployerReward = (round.ticketPrice * round.maxTickets * round.deployerRewardPercentage) / 100;

        // Calculate donation amount here and store it in the round struct
        round.donationAmount = (round.ticketPrice * round.maxTickets) - (round.winnerReward + round.deployerReward);

        emit WinnerSelected(winner, winningTicket, currentRound);	
        roundWinners[currentRound] = winner;
        roundWinningTickets[currentRound] = winningTicket;

        // Start a new round immediately
        currentRound++;

        // If new settings for the next round have been set, replace the corresponding settings
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

        // Reset the settings for the next round
        delete nextRoundSettings;
    }

    function withdrawReward(uint256 roundId) public {
        require(!roundRewardsDistributed[roundId], "Reward already distributed");
        Round storage round = rounds[roundId];
        require(msg.sender == round.winnerAddress, "Only the winner can withdraw the reward");

        acceptedToken.transfer(round.winnerAddress, round.winnerReward);
        acceptedToken.transfer(deployer, round.deployerReward);

        // Transfer the calculated donation amount
        if (round.donationAmount > 0) {
            acceptedToken.transfer(donationAddress, round.donationAmount);
        }

        emit Winner(round.winnerAddress, round.winnerReward, roundId);
        roundRewardsDistributed[roundId] = true;
    }

    function smartClaim() public{
        uint[] memory totalRounds = getArrayOfRoundsWinnersUnclaimed(msg.sender);
    	withdrawRewardMultiArray(totalRounds);
        claimedTo[msg.sender] = currentRound -1;  
    }

    function smartClaimTotalAmount(address user) public view returns (uint Rewardw){
        uint[] memory totalRounds = getArrayOfRoundsWinnersUnclaimed(user);
    	//withdrawRewardMultiArray(totalRounds);    
        uint TotToRec = 0;
    	for(uint x=0; x<totalRounds.length; x++){
        	Round storage round = rounds[totalRounds[x]];
    		if(!roundRewardsDistributed[totalRounds[x]] && msg.sender == round.winnerAddress){
    		 TotToRec = TotToRec + round.winnerReward;

    		}
    	}
        return TotToRec;
    }
    
    function getArrayOfRoundsWinnersAlreadyClaimed(address user) public view returns(uint256 [] memory) {
    	uint start = 0;
        uint count = 0;
    	uint[] memory WinDays = new uint[](currentRound - start + 1);
    	for(uint x=start; x<=currentRound; x++){
        	Round storage round = rounds[x];
    		if(roundRewardsDistributed[x] && user == round.winnerAddress){
    		 WinDays[count]=x;
             count++;
    		}
    	}
    	uint[] memory WinDays2 = new uint[](count);
    	for(uint x=0; x<count; x++){
    		WinDays2[x]=WinDays[x];
    	}
    	
    	return WinDays2;
    }

    function getArrayOfRoundsWinnersUnclaimed(address user) public view returns(uint256 [] memory) {
    	uint start = claimedTo[user];
        uint count = 0;
    	uint[] memory WinDays = new uint[](currentRound - start + 1);
    	for(uint x=start; x<=currentRound; x++){
        	Round storage round = rounds[x];
    		if(!roundRewardsDistributed[x] && user == round.winnerAddress){
    		 WinDays[count]=x;
             count++;
    		}
    	}
    	uint[] memory WinDays2 = new uint[](count);
    	for(uint x=0; x<count; x++){
    		WinDays2[x]=WinDays[x];
    	}
    	
    	return WinDays2;
    }


    function withdrawRewardMultiArray(uint256 [] memory roundIdzzzz) public {
    	uint TotToRec = 0;
    	uint DeployerToRec = 0;
    	uint dono = 0;
    	for(uint x=0; x<roundIdzzzz.length; x++){
        	Round storage round = rounds[roundIdzzzz[x]];
    		if(!roundRewardsDistributed[roundIdzzzz[x]] && msg.sender == round.winnerAddress){
    		 TotToRec = TotToRec + round.winnerReward;
    		 DeployerToRec = DeployerToRec + round.deployerReward;
    		 dono = dono + round.donationAmount;
    		 
        	roundRewardsDistributed[roundIdzzzz[x]] = true;
            emit Winner(round.winnerAddress, x, round.winnerReward);
    		}
    	}
    	
        acceptedToken.transfer(msg.sender, TotToRec);
        acceptedToken.transfer(deployer, DeployerToRec);

        // Transfer the calculated donation amount
        if (dono > 0) {
            acceptedToken.transfer(donationAddress, dono);
        }
        
    }
    
    
    
    
    function withdrawRewardForWinner(uint256 roundId) public {
        require(msg.sender == deployer, "Only the deployer can trigger a payout");
        require(!roundRewardsDistributed[roundId], "Reward already distributed");

        Round storage round = rounds[roundId];
        acceptedToken.transfer(round.winnerAddress, round.winnerReward);
        acceptedToken.transfer(deployer, round.deployerReward);

        // Transfer the calculated donation amount
        if (round.donationAmount > 0) {
            acceptedToken.transfer(donationAddress, round.donationAmount);
        }

        emit Winner(round.winnerAddress, round.winnerReward, roundId);
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
        // Copy the results into a smaller array
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
            // Copy the results into a smaller array
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
