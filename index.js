require('dotenv').config()

const fs = require('fs').promises; // Use fs.promises
const path = require('path');

const { ethers, BigNumber } = require('ethers')
const { logWithTimestamp, logWithTimestampAndSveToFile} = require('./lib/common')
const { quoteUniversalRouter, registerErrorHandler, npmContract, provider, provider2, signer, setupWebsocket, 
        getPool, getAllLogs, getPoolPrice, getAmounts, getTokenAssetPriceX96,
        getTickSpacing, getFlashloanPoolOptions, getV3VaultAddress, getFlashLoanLiquidatorAddress,
        executeTx, getTokenDecimals, getTokenSymbol, getPoolToToken,
        getRevertUrlForDiscord, getExplorerUrlForDiscord, importPools, Q32, Q96 } = require('./lib/common')

const v3VaultContract = new ethers.Contract(getV3VaultAddress(), require("./contracts/V3Vault.json").abi, provider)
const floashLoanLiquidatorContract = new ethers.Contract(getFlashLoanLiquidatorAddress(), require("./contracts/FlashloanLiquidator.json").abi, provider)

const positionLogInterval = 1 * 6000 // log positions each 1 min
const enableNonFlashloanLiquidation = false

var positions = {}
const cachedTokenDecimals = {}
const cachedCollateralFactorX32 = {}

let cachedExchangeRateX96
let asset, assetDecimals, assetSymbol
let lastWSLifeCheck = new Date().getTime()

let isCheckingAllPositions = false;

async function updateDebtExchangeRate() {
  const info = await v3VaultContract.vaultInfo()
  cachedExchangeRateX96 = info.debtExchangeRateX96
}


const STORAGE_PATH = path.join(__dirname, 'poolAddresses.json');

async function exportPoolstoCommon() {
  let pooladdress22 = {};
  const positionsArray = Object.values(positions);
  console.log(`Found ${positionsArray.length} positions to ExportPoolsToCommon`);

  for (let x = 0; x < positionsArray.length; x++) {
    const pos = positionsArray[x];
    if (pos.tokenId && !isNaN(pos.tokenId)) {
      const poolAddress = pos.poolAddress;
      if (poolAddress && !pooladdress22[poolAddress]) {
        pooladdress22[poolAddress] = true;
      }
    }
  }

  const uniquePoolAddresses = Object.keys(pooladdress22);
  
  // Read old addresses from file (or use empty array if file doesn't exist)
  let oldPoolAddresses = [];
  try {
    const data = await fs.readFile(STORAGE_PATH, 'utf8');
    oldPoolAddresses = JSON.parse(data);
  } catch (err) {
    if (err.code !== 'ENOENT') { // Ignore "file not found" error
      console.error('Error reading pool addresses:', err);
    }
  }
  
  // Compare with previous addresses
  const isDifferent = 
    uniquePoolAddresses.length !== oldPoolAddresses.length ||
    !uniquePoolAddresses.every(address => oldPoolAddresses.includes(address)) ||
    !oldPoolAddresses.every(address => uniquePoolAddresses.includes(address));
  
  // Save current addresses to file
  try {
    await fs.writeFile(STORAGE_PATH, JSON.stringify(uniquePoolAddresses));
  } catch (err) {
    console.error('Error saving pool addresses:', err);
  }
  
  await importPools(uniquePoolAddresses);
  return isDifferent;
}



async function loadActivePositions() {
  const filePath = path.join(__dirname, 'activePositions.json');

  try {
    const data = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(data);

    if (!parsed.positions || typeof parsed.blockNumber !== 'number') {
      console.error('Invalid file structure.');
      return;
    }

    // Convert positions with string values back to BigNumber objects
    const loadedPositions = {};
    
    for (const tokenId in parsed.positions) {
      const pos = parsed.positions[tokenId];
      loadedPositions[tokenId] = {
        ...pos,
        // Convert string values back to BigNumber
        liquidity: pos.liquidity ? ethers.BigNumber.from(pos.liquidity) : null,
        debtShares: pos.debtShares ? ethers.BigNumber.from(pos.debtShares) : null,
        fees0: pos.fees0 ? ethers.BigNumber.from(pos.fees0) : null,
        fees1: pos.fees1 ? ethers.BigNumber.from(pos.fees1) : null
      };
    }
    positions = loadedPositions;
    console.log(`[${new Date().toISOString()}] Loaded ${Object.keys(positions).length} positions from file before block ${parsed.blockNumber}`);
    LastBlockNumber = parsed.blockNumber;
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.warn(`[${new Date().toISOString()}] activePositions.json not found — starting fresh.`);
      positions = {};
    } else {
      console.error(`[${new Date().toISOString()}] Error loading positions:`, err);
    }
  }
}

async function saveActivePositions() {
  const filePath = path.join(__dirname, 'activePositions.json');
  const positionsToSave = {
    blockNumber: LastBlockNumber,
    positions: {}
  };

  const positionsArray = Object.values(positions);
  console.log(`Found ${positionsArray.length} positions to save`);
  
  for (let x = 0; x < positionsArray.length; x++) {
    const pos = positionsArray[x];
   // console.log("Saving position", parseInt(pos.tokenId, 10));
    if(pos.tokenId && pos.tokenId != NaN )

      {

        positionsToSave.positions[pos.tokenId.toString()] = {
          tokenId: pos.tokenId.toString(),
          liquidity: pos.liquidity,
          tickLower: pos.tickLower,
          tickUpper: pos.tickUpper,
          tickSpacing: pos.tickSpacing,
          fee: pos.fee,
          token0: pos.token0.toLowerCase(),
          token1: pos.token1.toLowerCase(),
          decimals0: pos.decimals0,
          decimals1: pos.decimals1,
          poolAddress: pos.poolAddress,
          debtShares: pos.debtShares,
          owner: pos.owner,
          collateralFactorX32: pos.collateralFactorX32,
          fees0: pos.fees0,
          fees1: pos.fees1,
          Factor: pos.Factor,
          lastCheckedAboveTwo: pos.lastCheckedAboveTwo,
          lastCheckedAboveTwo2: pos.lastCheckedAboveTwo2,
          isUpdating: pos.isUpdating,
          isChecking: pos.isChecking
        };


  }
  }

  try {
    await fs.writeFile(filePath, JSON.stringify(positionsToSave, null, 2), 'utf-8');

    console.log(`Saved positions with block #${LastBlockNumber} to ${filePath}`);
  } catch (err) {
    console.error('Error writing file:', err);
  }
}


const removedTokens = new Map(); // tokenId -> [{blockNumber, logIndex}]
let LastBlockNumber = 240513631;
async function loadPositions() {
      await loadActivePositions();
      var endBlock =  await getCurrentBlockNumber();
      console.log("Loaded Active Positions from file!");
      console.log("Getting new position moves after block: ", LastBlockNumber);
      
      logWithTimestamp(`Loaded a Total of ${Object.keys(positions).length} active positions from file, now doing stuff`);
      // Get all events first  // Get logs for each event type
     

        // Get logs for each event type
        let adds = await getAllLogs(v3VaultContract.filters.Add(), LastBlockNumber);
        let removes = await getAllLogs(v3VaultContract.filters.Remove(), LastBlockNumber);
        let borrows = await getAllLogs(v3VaultContract.filters.Borrow(), LastBlockNumber);
        let repays = await getAllLogs(v3VaultContract.filters.Repay(), LastBlockNumber);
        let withdrawCollaterals = await getAllLogs(v3VaultContract.filters.WithdrawCollateral(), LastBlockNumber);
        let increaseLiquidities
        if(LastBlockNumber == 240513631 ){
          console.log("Skipping increaes liquidities since its first run we getting positions anyway.")
          increaseLiquidities = await getAllLogs(npmContract.filters.IncreaseLiquidity(), endBlock);
        }else{
          
         increaseLiquidities = await getAllLogs(npmContract.filters.IncreaseLiquidity(), LastBlockNumber);
        }
        // Array to collect active tokenIds for batch processing
        let activeTokenIds = [];
        let loadedPositions = 0;
                
          for (const removeEvent of removes) {
            const parsedLog = v3VaultContract.interface.parseLog(removeEvent);
            const tokenId = parsedLog.args.tokenId.toString();
            
            const currentRemoval = {
              blockNumber: removeEvent.blockNumber,
              logIndex: removeEvent.logIndex
            };
            
            const existingRemoval = latestRemovals.get(tokenId);
            
            // Only update if this is a newer event
            if (!existingRemoval || isLaterEvent(currentRemoval, existingRemoval)) {
              latestRemovals.set(tokenId, currentRemoval);
            }
          }


        const processBatch = async () => {
          if (activeTokenIds.length > 0) {
            // Remove any duplicate tokenIds within the batch
            const uniqueTokenIds = Array.from(new Set(activeTokenIds.map(id => id.toString())))
              .map(idStr => activeTokenIds.find(id => id.toString() === idStr));
            
            // Process only unique tokenIds
            await updatePositionMULTI(uniqueTokenIds, true);
            loadedPositions += uniqueTokenIds.length;
            activeTokenIds = [];
          }
        };
        
        const uniqueTokenIdStrings = new Set();
        // Process Add events and check if they're still active
        while (adds.length > 0) {
          const event = adds[adds.length - 1];
          const tokenId = v3VaultContract.interface.parseLog(event).args.tokenId;
          
          // Check if this position was later removed
          const isActive =  !wasTokenRemoved(tokenId, event.blockNumber, event.logIndex);
  

          // At the beginning

            // When processing
            const tokenIdStr = tokenId.toString();
            
          //  console.log("Dog time, tokenIdStr: ", tokenIdStr);
            if (isActive && !uniqueTokenIdStrings.has(tokenIdStr)) {
              uniqueTokenIdStrings.add(tokenIdStr);
              activeTokenIds.push(tokenId);
              console.log("Dog Adds activeTokenIds: ", activeTokenIds);
              
              // Process batch when we reach 25 tokens
              if (activeTokenIds.length >= 25) {
                await processBatch();
              }
            }
        //  console.log("Dog time4");
          // Remove all events for this tokenId from the adds array
        //  console.log("Dog time5");

          // Remove just the current event from the adds array
          adds.pop(); // Since we're getting the last element with adds[adds.length - 1]
          

        }
        
        
        // Set to track processed tokenIds
        const processedTokenIds = new Set();
        
        // Function to process events and collect tokenIds
        const processEventArray = async (events, contract) => {
          for (const event of events) {
            const tokenId = contract.interface.parseLog(event).args.tokenId;
            const tokenIdStr = tokenId.toString();
            
            // Skip if we've already processed this tokenId
            if (processedTokenIds.has(tokenIdStr)) continue;
            processedTokenIds.add(tokenIdStr);
              // Check if this position was later removed
          const isActive =  !wasTokenRemoved(tokenId, event.blockNumber, event.logIndex);
  

            
           // console.log("Dog time444, tokenIdStr: ", tokenIdStr);
            if (isActive && !uniqueTokenIdStrings.has(tokenIdStr)) {
              uniqueTokenIdStrings.add(tokenIdStr);
              activeTokenIds.push(tokenId);
              // Process batch when we reach 25 tokens
              if (activeTokenIds.length >= 25) { 
                
                console.log("Dog timeProcessEvent activeTokenIds: ", activeTokenIds);
             
                await processBatch();
              }
            }
          }
        };
        
        // Process various event types
        await processEventArray(borrows, v3VaultContract);
        await processEventArray(repays, v3VaultContract);
        await processEventArray(withdrawCollaterals, v3VaultContract);
        
        // Process increase liquidity events (only for positions we care about)
        for (const event of increaseLiquidities) {
          const tokenId = npmContract.interface.parseLog(event).args.tokenId;
          const tokenIdStr = tokenId.toString();
          
          // Skip if we've already processed this tokenId or if it's not in our positions
          if (processedTokenIds.has(tokenIdStr) || !positions[tokenIdStr]) continue;
          processedTokenIds.add(tokenIdStr);
          
          activeTokenIds.push(tokenId);
          
          // Process batch when we reach 25 tokens
          if (activeTokenIds.length >= 25) {
            await processBatch();
          }
        }
        
        // Process any remaining tokens
        await processBatch();





      logWithTimestamp(`Loaded ${loadedPositions} active positions`);
      LastBlockNumber = await getCurrentBlockNumber();
  //save all positions and info now
  saveActivePositions();
}


// Helper function to compare event ordering
function isLaterEvent(event1, event2) {
  return event1.blockNumber > event2.blockNumber || 
         (event1.blockNumber === event2.blockNumber && event1.logIndex > event2.logIndex);
}


// Store only the latest removal event for each token
const latestRemovals = new Map();

function wasTokenRemoved(tokenId, eventBlockNumber, eventLogIndex) {
  const latestRemoval = latestRemovals.get(tokenId.toString());
  if (!latestRemoval) return false;
  
  return latestRemoval.blockNumber > eventBlockNumber || 
         (latestRemoval.blockNumber === eventBlockNumber && 
          latestRemoval.logIndex > eventLogIndex);
}


// Get the current block number from the provider
async function getCurrentBlockNumber() {
  try {
      // Assuming you have a provider already initialized somewhere in your code
      // If not, you'll need to create one like:
      // const provider = new ethers.providers.JsonRpcProvider(YOUR_RPC_URL);
      
      const currentBlockNumber = await provider.getBlockNumber();
      console.log(`Current block number: ${currentBlockNumber}`);
      return currentBlockNumber;
  } catch (error) {
      console.error("Error getting current block number:", error);
      await new Promise(resolve => setTimeout(resolve, 10000)); //10 sec wait for new getCurrentBlock();

      return getCurrentBlockNumber();
      throw error;
  }
}



const SUPERINFOCONTRACT = new ethers.Contract('0x0133823bCFb6C59A6d164AA88C620e195F04Dee0', require("./contracts/FIEOFj21___UpdatePositionManager.json"), provider2)



async function checkPositionMULTI_FIN(position) {

let tokenIds = [];
let validPositions = [];

for (let zvvv = 0; zvvv < position.length; zvvv++) {
  const tok = position[zvvv].tokenId;

  if (
    !tok ||
    typeof tok.toString !== 'function' ||
    String(tok) === '[object Object]'
  ) {
    console.warn(`Skipping invalid tokenId at index ${zvvv}:`, tok);
    continue;
  }

  try {
    tokenIds.push(parseInt(tok.toString(), 10));
    validPositions.push(position[zvvv]);
  } catch (e) {
    console.warn(`Error parsing tokenId at index ${zvvv}:`, tok, e);
  }
}


const superGetter = await SUPERINFOCONTRACT.checkPosition_Multi_Multi(tokenIds);

for (let xz = 0; xz < superGetter.length; xz++) {
  const pos = validPositions[xz];
  let getUpdate = false;
  if (!pos || pos.isChecking || pos.isExecuting || pos.isUpdating) {
  //  console.log("Error here: 123213: Now result: ", superGetter);
    if(pos.isChecking){
   //   console.log( "Error here isChecking");
    }
        if(pos.isExecuting){
  //    console.log( "Error here isChecking");
    }
        if(pos.isUpdating){
    //  console.log( "Error here isChecking");
    }
    continue;
  }

  pos.isChecking = true;
 // console.log("pos.tokeNId: ", pos.tokenId);
    const positionFINALSTUFF = {
      poolAddress: superGetter[xz][0],
      MAINsqrtPriceX96: superGetter[xz][1],
      SqrtPriceX96low: superGetter[xz][2],
      SqrtPriceX96high: superGetter[xz][3],
      fees0: superGetter[xz][4],
      fees1: superGetter[xz][5],
      token0Price2: superGetter[xz][6],
      token1Price2: superGetter[xz][7],
      aliquidationValue: superGetter[xz].aliquidationValue,
      afullValue: superGetter[xz].afullValue,
      aliquidationCost: superGetter[xz].aliquidationCost
    };
    
let collateralValue; // Declare it outside the try block
let debtValue; // Declare it outside the try block

    try {
    let { amount0, amount1 } = getAmountsForLiquidity(
      positionFINALSTUFF.MAINsqrtPriceX96,
      positionFINALSTUFF.SqrtPriceX96low,
      positionFINALSTUFF.SqrtPriceX96high,
      pos.liquidity
    );

var amount0Added = amount0.add(positionFINALSTUFF.fees0);
var amount1Added = amount1.add(positionFINALSTUFF.fees1);
   // console.log("Amount0: ",amount0.toString(), " + fees: ",positionFINALSTUFF.fees0.toString()," = TotalAmount0: ",amount0Added.toString());
   // console.log("Amount1: ",amount1.toString(), " + fees: ",positionFINALSTUFF.fees1.toString()," = TotalAmount1: ",amount1Added.toString());
    amount0 = amount0.add(positionFINALSTUFF.fees0);
    amount1 = amount1.add(positionFINALSTUFF.fees1);
    const price0X96 = positionFINALSTUFF.token0Price2;
    const price1X96 = positionFINALSTUFF.token1Price2;

    const assetValue = price0X96.mul(amount0).div(Q96).add(price1X96.mul(amount1).div(Q96));
    collateralValue = assetValue.mul(pos.collateralFactorX32).div(Q32);
    debtValue = pos.debtShares.mul(cachedExchangeRateX96).div(Q96);

    let factor;
    //try {
    factor = collateralValue.mul(100).div(debtValue);
    let newFactor = factor.toNumber() / 100;
    pos.Factor = newFactor

    

    if (debtValue.gt(0) && (!pos.lastLog || pos.lastLog + positionLogInterval < Date.now())) {
      if (newFactor <= 1.1) {
        const msg = `LOW collateral factor ${(newFactor).toFixed(2)} for ${getRevertUrlForDiscord(pos.tokenId)} with debt ${ethers.utils.formatUnits(debtValue, assetDecimals)} ${assetSymbol} with This much value rn: ${positionFINALSTUFF.aliquidationValue.toString()}`;
        logWithTimestamp(msg);
        pos.lastLog = Date.now();
        getUpdate=true;
      }else if(newFactor < 1.5){
        const msg = `Medium collateral factor ${(newFactor).toFixed(2)} for ${getRevertUrlForDiscord(pos.tokenId)} with debt ${ethers.utils.formatUnits(debtValue, assetDecimals)} ${assetSymbol} with This much value rn: ${positionFINALSTUFF.aliquidationValue.toString()}`;
        logWithTimestamp(msg);
        pos.lastLog = Date.now();
       
      }
    }

  } catch (err) {
    logWithTimestamp("Error checking position " + pos.tokenId?.toString?.(), err);
    console.log("Error Stuff: CollateralValue = ", collateralValue.toString(), " !! debtVValue = ",debtValue.toString()); 
  }
 /* console.log("Checking to make sure position is called corrrectly")
  console.log("Checking to make sure position is called corrrectly, position[xz].poolAddress: ", position[xz].poolAddress)
  console.log("Checking to make sure position is called corrrectly, position[xz].poolAddress: ", position[xz].poolAddress)
  console.log("Checking to make sure position is called corrrectly, position[xz].token0: ", position[xz].token0)
  console.log("Checking to make sure position is called corrrectly, position[xz].decimals0: ", position[xz].decimals0)
  console.log("Checking to make sure position is called corrrectly, position[xz].token1: ", position[xz].token1)
  console.log("Checking to make sure position is called corrrectly, position[xz].decimals1: ", position[xz].decimals1)
  console.log("Checking to make sure position is called corrrectly, position[xz].debtShares: ", position[xz].debtShares)
  console.log("Checking to make sure position is called corrrectly, position[xz].tokenId: ", position[xz].tokenId)

*/
  
  if (positionFINALSTUFF && positionFINALSTUFF.aliquidationValue.gt(0)) {


    logWithTimestampAndSveToFile("Attempting to Liquidate tokenID: ", pos.tokenId);

    // run liquidation - step II  
    try {
      // amount that will be available to the contract - remove a bit for withdrawal slippage
      var amount0Available = amount0.mul(995).div(1000).mul(positionFINALSTUFF.aliquidationValue).div(positionFINALSTUFF.afullValue)
      var amount1Available = amount1.mul(995).div(1000).mul(positionFINALSTUFF.aliquidationValue).div(positionFINALSTUFF.afullValue)

      var deadline = Math.floor(Date.now() / 1000 + 1800)

      // prepare swaps
      let amount0In = BigNumber.from(0)
      let swapData0 = "0x"
      let pools = []
      if (pos.token0 != asset && amount0Available.gt(0)) {
        amount0In = amount0Available
        var quote = await quoteUniversalRouter(pos.token0, asset, pos.decimals0, assetDecimals, amount0In, floashLoanLiquidatorContract.address, 100, deadline, 0, ethers.constants.AddressZero)
        swapData0 = quote.data
        pools.push(...quote.pools.map(p => p.toLowerCase()))
      }

      let amount1In = BigNumber.from(0)
      let swapData1 = "0x"
      if (pos.token1 != asset && amount1Available.gt(0)) {
        amount1In = amount1Available
        var quote = await quoteUniversalRouter(pos.token1, asset, pos.decimals1, assetDecimals, amount1In, floashLoanLiquidatorContract.address, 100, deadline, 0, ethers.constants.AddressZero)
        swapData1 = quote.data
        pools.push(...quote.pools.map(p => p.toLowerCase()))
      }

      pools.push(pos.poolAddress)

      var flashLoanPoolOptions = getFlashloanPoolOptions(asset)
      var flashLoanPool = flashLoanPoolOptions.filter(o => !pools.includes(o.toLowerCase()))[0]

      var reward =  positionFINALSTUFF.aliquidationValue.sub(positionFINALSTUFF.aliquidationCost)
      
      var minReward = BigNumber.from(0) // 0% of reward must be recieved in assset after swaps and everything - rest in leftover token - no problem because flashloan liquidation

      let params = {tokenId : pos.tokenId, debtShares: pos.debtShares, vault: v3VaultContract.address, flashLoanPool, amount0In, swapData0, amount1In, swapData1, minReward, deadline  } 
            
      let useFlashloan = true
      let gasLimit
      try {
        gasLimit = await floashLoanLiquidatorContract.connect(signer).estimateGas.liquidate(params)
      } catch (err) {
        logWithTimestamp("Error trying flashloan liquidation for " + pos.tokenId, err)
        logWithTimestampAndSveToFile("Error trying flashloan liquidation for,", pos.tokenId, "   !! params =  " + pos.tokenId, params)

        if (enableNonFlashloanLiquidation) {
          // if there is any error with liquidation - fallback to non-flashloan liquidation
          useFlashloan = false
          params = { tokenId : pos.tokenId, amount0Min: BigNumber.from(0), amount1Min: BigNumber.from(0), recipient: signer.address, permitData: "0x", deadline}
          gasLimit = await v3VaultContract.connect(signer).estimateGas.liquidate(params)
        } else {
          throw err
        }
      }
              
      const tx = useFlashloan ? 
                    await floashLoanLiquidatorContract.populateTransaction.liquidate(params, { gasLimit: gasLimit.mul(125).div(100) }) : 
                    await v3VaultContract.populateTransaction.liquidate(params, { gasLimit: gasLimit.mul(125).div(100) })


                    isExecutingALL = true;
                    pos.isExecuting = true 
                    
      const { hash, error } = await executeTx(tx, async (success) => {
        pos.isExecuting = false
        isExecutingALL = false
      })

      isExecutingALL = false
      if (hash) {
          const msg = `Executing liquidation ${useFlashloan ? "with" : "without" } flashloan for ${getRevertUrlForDiscord(position[xz].tokenId)} with reward of ${ethers.utils.formatUnits(reward, assetDecimals)} ${assetSymbol} - ${getExplorerUrlForDiscord(hash)}`
          logWithTimestamp(msg)
          logWithTimestampAndSveToFile(msg)
      } else {
        const msg = `ERRROR : ERROR: Executing liquidation ${useFlashloan ? "with" : "without" } flashloan for ${getRevertUrlForDiscord(position[xz].tokenId)} with reward of ${ethers.utils.formatUnits(reward, assetDecimals)} ${assetSymbol} - ${getExplorerUrlForDiscord(hash)}`

          throw error
      }
    } catch (err) { 
      logWithTimestamp("Error liquidating position " + pos.tokenId.toString(), err)
      
      logWithTimestampAndSveToFile("Error liquidating position " + pos.tokenId.toString(), err)
      
      isExecutingALL = false
    }
  } else if( getUpdate ){
   //console.log("Token is close to liq: ",pos.tokenId );
     // update values if not liquidatable - but estimation indicated it was
    
     pos.isChecking = false
    //await updatePosition(position[xz].tokenId.toString())
  }
  pos.isChecking = false
  
}
//console.log("Tokens checkedPositionMULTI_FIN:  ",tokenIds );
   
}







// Function to calculate token amounts for a position
function getAmountsForLiquidity(
  currentSqrtRatioX96,
  sqrtRatioAX96,
  sqrtRatioBX96,
  liquidity
) {
  // Convert all inputs to BigNumber
  currentSqrtRatioX96 = ethers.BigNumber.from(currentSqrtRatioX96);
  sqrtRatioAX96 = ethers.BigNumber.from(sqrtRatioAX96);
  sqrtRatioBX96 = ethers.BigNumber.from(sqrtRatioBX96);
  liquidity = ethers.BigNumber.from(liquidity);
  
  // Ensure sqrtRatioAX96 is lower than sqrtRatioBX96
  if (sqrtRatioAX96.gt(sqrtRatioBX96)) {
    [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  }
  
  let amount0 = ethers.BigNumber.from(0);
  let amount1 = ethers.BigNumber.from(0);
  
  if (currentSqrtRatioX96.lte(sqrtRatioAX96)) {
    // Current price is below range - all liquidity is in token0
    amount0 = getAmount0ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity);
  } else if (currentSqrtRatioX96.lt(sqrtRatioBX96)) {
    // Current price is within range - liquidity is split between both tokens
    amount0 = getAmount0ForLiquidity(currentSqrtRatioX96, sqrtRatioBX96, liquidity);
    amount1 = getAmount1ForLiquidity(sqrtRatioAX96, currentSqrtRatioX96, liquidity);
  } else {
    // Current price is above range - all liquidity is in token1
    amount1 = getAmount1ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity);
  }
  
  return { amount0, amount1 };
}


// Helper function to calculate amount of token0
function getAmount0ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity) {
  const Q96 = ethers.BigNumber.from('2').pow(96);
  
  // Convert to readable format for calculation
  const numerator = liquidity.mul(Q96).mul(sqrtRatioBX96.sub(sqrtRatioAX96));
  const denominator = sqrtRatioBX96.mul(sqrtRatioAX96);
  
  // Use ethers' built-in division which handles large numbers
  return numerator.div(denominator);
}

// Helper function to calculate amount of token1
function getAmount1ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity) {
  // Convert to readable format for calculation
  const numerator = liquidity.mul(sqrtRatioBX96.sub(sqrtRatioAX96));
  const denominator = ethers.constants.WeiPerEther; // We need to divide by 2^96 but this is an approximation
  
  // The actual formula is:
  // return liquidity * (sqrtRatioBX96 - sqrtRatioAX96) / 2^96
  return numerator.div(ethers.BigNumber.from(2).pow(96));
}



let BATCH_SIZE1 = 25
async function checkAllPositionsAtOnce() {
  if (isCheckingAllPositions) {
    logWithTimestamp("Regular check of all positions is already in progress. Skipping this execution.");
    return;
  }

  isCheckingAllPositions = true;
  logWithTimestamp("Performing regular check of all positions");

  // Extract positions into two categories: immediate check and delayed check (rate limited)
  const immediateCheckPositions = [];
  const delayedCheckPositions = [];
  const extremlydelayedCheckPositions = [];

  const time = new Date();
  const tokenIds = Object.values(positions).map(position => {
    const factor = position.Factor;
    if (factor === undefined || factor <= 2.0) {
      immediateCheckPositions.push(position.tokenId);
    } else {
      delayedCheckPositions.push(position);
    }
    
    position.lastCheckedAboveTwo2 = time.getTime();
    return position.tokenId;
  });

  // Process immediate check positions first (Factor <= 2.0 or unset)
  for (let i = 0; i < immediateCheckPositions.length; i += BATCH_SIZE1) {
    const batch = immediateCheckPositions.slice(i, i + BATCH_SIZE1); // Get the next batch of 20 tokenIds
    if (batch.length > 0) {
      console.log(`Processing batch of ${batch.length} immediate check positions`);
      await updatePositionMULTI(batch, false); // Send the batch to the update function
    }
  }

  const positionsToProcess = [];

  for (const pos of delayedCheckPositions) {
    const tokenIdStr = pos.tokenId.toString();
    const lastCheckTime = pos.lastCheckedAboveTwo2 || 0;

    if (time.getTime() - lastCheckTime > 7200000) { // 120 minutes = 7200000 ms
      // Mark the position as processed and update the last check time
      pos.lastCheckedAboveTwo2 = time.getTime();
      positionsToProcess.push(pos.tokenId);
    }
  }

  // Now process the delayed positions in batches of 20
  for (let i = 0; i < positionsToProcess.length; i += BATCH_SIZE1) {
    const batch = positionsToProcess.slice(i, i + BATCH_SIZE1); // Get the next batch of 20 tokenIds
    if (batch.length > 0) {
      console.log(`Processing batch of ${batch.length} delayed check positions`);
      await updatePositionMULTI(batch, false); // Send the batch to the update function
    }
  }

  logWithTimestamp("Regular check of all positions completed successfully");
  console.log("Saving active positions to file after CheckAllPositionsAtOnce was run");
  saveActivePositions();
  console.log("Saved active positions to file  after CheckAllPositionsAtOnce was run");

  isCheckingAllPositions = false;
}


let isExecutingALL = false;




// loads all needed data for position
async function updatePositionMULTI(tokenIdSZ, updateTimerz) {
  if( isExecutingALL ){
    return;
  }

  const fullPositionDetails = await SUPERINFOCONTRACT.getFullPositionDetails_MULTI(tokenIdSZ);
  
for(var x =0; x<tokenIdSZ.length; x++){

//console.log("fullPositionDetails: ",fullPositionDetails);
  // Since fullPositionDetails contains an array with a single nested array, we need to access the nested array
const positionData = fullPositionDetails[x];  // Access the first (and only) nested array
 // console.log("positionData look for pooladdress: ", positionData);

 // console.log("fullPositionDetails length = ", fullPositionDetails.legnth)
 // console.log("FUll pos: ", fullPositionDetails);
  const position = {
      token0: positionData[0],
      token1: positionData[1],
      fee: positionData[2],
      tickLower: positionData[3],
      tickUpper: positionData[4],
      liquidity: positionData[5],
      tokensOwed0: positionData[6], //dont need
      tokensOwed1: positionData[7], // dont need
      decimalsToken0: positionData[8],
      decimalsToken1:positionData[9],
      poolAddress: positionData[10].toLowerCase(),
      fees0: positionData[11],
      fees1: positionData[12],
      collateralFactorX32T0: positionData[13],
      collateralValueLimitFactorX32T0: positionData[14], //dont need
      totalDebtSharesT0: positionData[15], //dont need
      collateralFactorX32T1: positionData[16],
      collateralValueLimitFactorX32T1: positionData[17], //dont need
      totalDebtSharesT1: positionData[18], //dont need
      debtShares: positionData[19],
      ownerOf: positionData[20]
  };

  

  //console.log("FUll position: ", position);
  // Now you have all the variables in one object
  //console.log(position);
 // console.log("position token0: ", position.token0);



  if (positions[tokenIdSZ[x]] && (positions[tokenIdSZ[x]].isChecking || positions[tokenIdSZ[x]].isExecuting || positions[tokenIdSZ[x]].isUpdating)) { 
   // console.log("Error in token ID: ",tokenIdSZ[x], 'calling updatePosition in 10 sec');
    setTimeout(async() => await updatePosition(tokenIdSZ[x]), 10000)
    continue;
  }

  if (!positions[tokenIdSZ[x]]) {
    positions[tokenIdSZ[x]] = { isUpdating: true }
  } else {
    positions[tokenIdSZ[x]].isUpdating = true
  }
  
  try {
    const debtShares = position.debtShares //await v3VaultContract.loans(tokenId)
    if (debtShares.gt(0)) {
      // add or update

     // const { liquidity, tickLower, tickUpper, fee, token0, token1 } = await npmContract.positions(tokenId);
     const liquidity = position.liquidity
     const tickLower =  position.tickLower
     const tickUpper =  position.tickUpper
     const fee =  position.fee
     const token0 =  position.token0
     const token1 =  position.token1





      const tickSpacing = getTickSpacing(fee)
      
      const poolAddress =  position.poolAddress
      //console.log("Pool address: ", poolAddress);
      
      const owner =  position.ownerOf

      // get current fees - for estimation
      const fees0z = position.fees0
      const fees1z = position.fees1
    //  console.log("FEES WE NEED TO CHECK THIS PERFECT:  fees.amount0: ", fees0z.toString(), "   !  fees.amount1: ", fees1z.toString() ,'   ! TokenID: ', tokenIdSZ[x].toString());
    // console.log("debtShares: ", debtShares.toString(), "   ! owner: ", owner.toString() ,'   ! TokenID: ', tokenIdSZ[x].toString());
      if (cachedTokenDecimals[token0] === undefined) {
        cachedTokenDecimals[token0] = position.decimalsToken0
      }
      if (cachedTokenDecimals[token1] === undefined) {
        cachedTokenDecimals[token1] =  position.decimalsToken1
      }
      const decimals0 = cachedTokenDecimals[token0]
      const decimals1 = cachedTokenDecimals[token1]

      
      if (!cachedCollateralFactorX32[token0]) {
        cachedCollateralFactorX32[token0] = position.collateralFactorX32T0
      }
      if (!cachedCollateralFactorX32[token1]) {
        cachedCollateralFactorX32[token1] = position.collateralFactorX32T1
      }
      tokenId = tokenIdSZ[x].toString()
      const collateralFactorX32 = cachedCollateralFactorX32[token0] < cachedCollateralFactorX32[token1] ? cachedCollateralFactorX32[token0] : cachedCollateralFactorX32[token1]
      //console.log("Old output for tokenIdSz[x]", tokenIdSZ[x], "  !! new output: ", tokenIdSZ[x].toString() )
      positions[tokenIdSZ[x].toString()] = { ...positions[tokenIdSZ[x].toString()], tokenId, liquidity, tickLower, tickUpper, tickSpacing, fee, token0: token0.toLowerCase(), token1: token1.toLowerCase(), decimals0, decimals1, poolAddress, debtShares, owner, collateralFactorX32, fees0: fees0z, fees1: fees1z }
      if(updateTimerz){
        positions[tokenIdSZ[x].toString()].lastCheckedAboveTwo = 0;
      }

    } else {
      delete positions[tokenIdSZ[x].toString()]
    }
  } catch(err) {
    // retry on error after 1 min
    setTimeout(async() => await updatePosition(tokenIdSZ[x].toString()), 60000)
    logWithTimestamp("Error updating position " + tokenIdSZ[x].toString(), err)
  }

  if (positions[tokenIdSZ[x].toString()]) {
    positions[tokenIdSZ[x].toString()].isUpdating = false
  }


 // console.log("Checked this: multiWay: ", tokenIdSZ[x].toString())
  //return position;
}
console.log(
  "tokenIdSZ THAT ALL WERE JUST UpdatePositionMulti: ",
  tokenIdSZ.map(x => x.toString())
);

}








































































































// loads all needed data for position
async function updatePosition(tokenId) {
  if(String(tokenId) == '[object Object]'){
   // console.log("Bad tokenID returning outa here")
    return;
  }
  // if processing - retry later
  if (positions[tokenId] && (positions[tokenId].isChecking || positions[tokenId].isExecuting || positions[tokenId].isUpdating)) { 
    //console.log("2Error in token ID: ",tokenId, 'calling updatePosition in 10 sec');

    setTimeout(async() => await updatePosition(tokenId), 10000)
    return
  }

  if (!positions[tokenId]) {
    positions[tokenId] = { isUpdating: true }
  } else {
    positions[tokenId].isUpdating = true
  }
  
  try {
    const debtShares = await v3VaultContract.loans(tokenId)
    if (debtShares.gt(0)) {
      // add or update
      const { liquidity, tickLower, tickUpper, fee, token0, token1 } = await npmContract.positions(tokenId);
      const tickSpacing = getTickSpacing(fee)
      const poolAddress = await getPool(token0, token1, fee)
      
      const owner = await v3VaultContract.ownerOf(tokenId)

      // get current fees - for estimation
      const fees = await npmContract.connect(v3VaultContract.address).callStatic.collect([tokenId, ethers.constants.AddressZero, BigNumber.from(2).pow(128).sub(1), BigNumber.from(2).pow(128).sub(1)])

      if (cachedTokenDecimals[token0] === undefined) {
        cachedTokenDecimals[token0] = await getTokenDecimals(token0)
      }
      if (cachedTokenDecimals[token1] === undefined) {
        cachedTokenDecimals[token1] = await getTokenDecimals(token1)
      }
      const decimals0 = cachedTokenDecimals[token0]
      const decimals1 = cachedTokenDecimals[token1]

      if (!cachedCollateralFactorX32[token0]) {
        const tokenConfig = await v3VaultContract.tokenConfigs(token0)
        cachedCollateralFactorX32[token0] = tokenConfig.collateralFactorX32
      }
      if (!cachedCollateralFactorX32[token1]) {
        const tokenConfig = await v3VaultContract.tokenConfigs(token1)
        cachedCollateralFactorX32[token1] = tokenConfig.collateralFactorX32
      }

      const collateralFactorX32 = cachedCollateralFactorX32[token0] < cachedCollateralFactorX32[token1] ? cachedCollateralFactorX32[token0] : cachedCollateralFactorX32[token1]

      positions[tokenId] = { ...positions[tokenId], tokenId, liquidity, tickLower, tickUpper, tickSpacing, fee, token0: token0.toLowerCase(), token1: token1.toLowerCase(), decimals0, decimals1, poolAddress, debtShares, owner, collateralFactorX32, fees0: fees.amount0, fees1: fees.amount1 }

        positions[tokenId].lastCheckedAboveTwo = 0;

    } else {
      delete positions[tokenId]
    }
  } catch(err) {
    // retry on error after 1 min   
    console.log("1Error in token ID: ",tokenId, 'calling updatePosition in 10 sec');

    setTimeout(async() => await updatePosition(tokenId), 60000)
    logWithTimestamp("Error updating position " + tokenId.toString(), err)
  }

  if (positions[tokenId]) {
    positions[tokenId].isUpdating = false
  }
}

// checks position 
async function checkPosition(position) {
  
  if (!position || position.isChecking || position.isExecuting || position.isUpdating) {
    return
  }
  position.isChecking = true

  let info, amount0, amount1

  // check if liquidation needed - step I  
  try {
    const poolPrice = await getPoolPrice(position.poolAddress)
    const amounts = position.liquidity.gt(0) ? getAmounts(poolPrice.sqrtPriceX96, position.tickLower, position.tickUpper, position.liquidity) : { amount0: BigNumber.from(0), amount1 : BigNumber.from(0) }
    amount0 = amounts.amount0.add(position.fees0)
    amount1 = amounts.amount1.add(position.fees1)

    const price0X96 = await getTokenAssetPriceX96(position.token0, asset)
    const price1X96 = await getTokenAssetPriceX96(position.token1, asset)

    const assetValue = price0X96.mul(amount0).div(Q96).add(price1X96.mul(amount1).div(Q96))
    const collateralValue = assetValue.mul(position.collateralFactorX32).div(Q32)
    const debtValue = position.debtShares.mul(cachedExchangeRateX96).div(Q96)

    if (debtValue.gt(collateralValue)) {
      // only call this once per minute to update position (&fees)
      if (!position.lastLiquidationCheck || position.lastLiquidationCheck + 60000 < Date.now()) {
        info = await v3VaultContract.loanInfo(position.tokenId)
        position.lastLiquidationCheck = Date.now()
      }
    }

    if (debtValue.gt(0) && (!position.lastLog || position.lastLog + positionLogInterval < Date.now())) {
      const factor = collateralValue.mul(100).div(debtValue).toNumber() / 100
      if (factor <= 1.1) {
        const msg = `Low collateral factor ${factor.toFixed(2)} for ${getRevertUrlForDiscord(position.tokenId)} with debt ${ethers.utils.formatUnits(debtValue, assetDecimals)} ${assetSymbol}`
        logWithTimestamp(msg)
        position.lastLog = Date.now()
      }
    }

  } catch (err) { 
    logWithTimestamp("Error checking position " + position.tokenId.toString(), err)
    info = null
  }

  if (info && info.liquidationValue.gt(0)) {

    // run liquidation - step II  
    try {
      // amount that will be available to the contract - remove a bit for withdrawal slippage
      const amount0Available = amount0.mul(995).div(1000).mul(info.liquidationValue).div(info.fullValue)
      const amount1Available = amount1.mul(995).div(1000).mul(info.liquidationValue).div(info.fullValue)

      const deadline = Math.floor(Date.now() / 1000 + 1800)

      // prepare swaps
      let amount0In = BigNumber.from(0)
      let swapData0 = "0x"
      let pools = []
      if (position.token0 != asset && amount0Available.gt(0)) {
        amount0In = amount0Available
        const quote = await quoteUniversalRouter(position.token0, asset, position.decimals0, assetDecimals, amount0In, floashLoanLiquidatorContract.address, 100, deadline, 0, ethers.constants.AddressZero)
        swapData0 = quote.data
        pools.push(...quote.pools.map(p => p.toLowerCase()))
      }

      let amount1In = BigNumber.from(0)
      let swapData1 = "0x"
      if (position.token1 != asset && amount1Available.gt(0)) {
        amount1In = amount1Available
        const quote = await quoteUniversalRouter(position.token1, asset, position.decimals1, assetDecimals, amount1In, floashLoanLiquidatorContract.address, 100, deadline, 0, ethers.constants.AddressZero)
        swapData1 = quote.data
        pools.push(...quote.pools.map(p => p.toLowerCase()))
      }

      pools.push(position.poolAddress)

      const flashLoanPoolOptions = getFlashloanPoolOptions(asset)
      const flashLoanPool = flashLoanPoolOptions.filter(o => !pools.includes(o.toLowerCase()))[0]

      const reward = info.liquidationValue.sub(info.liquidationCost)
      
      const minReward = BigNumber.from(0) // 0% of reward must be recieved in assset after swaps and everything - rest in leftover token - no problem because flashloan liquidation

      let params = {tokenId : position.tokenId, debtShares: position.debtShares, vault: v3VaultContract.address, flashLoanPool, amount0In, swapData0, amount1In, swapData1, minReward, deadline  } 
            
      let useFlashloan = true
      let gasLimit
      try {
        gasLimit = await floashLoanLiquidatorContract.connect(signer).estimateGas.liquidate(params)
      } catch (err) {
        logWithTimestamp("Error trying flashloan liquidation for " + position.tokenId.toString(), err)

        if (enableNonFlashloanLiquidation) {
          // if there is any error with liquidation - fallback to non-flashloan liquidation
          useFlashloan = false
          params = { tokenId : position.tokenId, amount0Min: BigNumber.from(0), amount1Min: BigNumber.from(0), recipient: signer.address, permitData: "0x", deadline}
          gasLimit = await v3VaultContract.connect(signer).estimateGas.liquidate(params)
        } else {
          throw err
        }
      }
              
      const tx = useFlashloan ? 
                    await floashLoanLiquidatorContract.populateTransaction.liquidate(params, { gasLimit: gasLimit.mul(125).div(100) }) : 
                    await v3VaultContract.populateTransaction.liquidate(params, { gasLimit: gasLimit.mul(125).div(100) })

      position.isExecuting = true 
      const { hash, error } = await executeTx(tx, async (success) => {
          position.isExecuting = false
      })

      if (hash) {
          const msg = `Executing liquidation ${useFlashloan ? "with" : "without" } flashloan for ${getRevertUrlForDiscord(position.tokenId)} with reward of ${ethers.utils.formatUnits(reward, assetDecimals)} ${assetSymbol} - ${getExplorerUrlForDiscord(hash)}`
          logWithTimestamp(msg)
      } else {
          throw error
      }
    } catch (err) { 
      logWithTimestamp("Error liquidating position " + position.tokenId.toString(), err)
    }
  } else if (info) {
    // update values if not liquidatable - but estimation indicated it was
    position.isChecking = false
    console.log("Saving a update position for only important");
  //  await updatePosition(position.tokenId)
  }

  position.isChecking = false
}

async function checkAllPositions() {
  if (isCheckingAllPositions) {
    logWithTimestamp("Regular check of all positions is already in progress. Skipping this execution.");
    return;
  }

  isCheckingAllPositions = true;
  logWithTimestamp("Performing regular check of all positions");

  try {
    for (const position of Object.values(positions)) {
      await checkPosition(position);
    }
    logWithTimestamp("Regular check of all positions completed successfully");
  } catch (error) {
    logWithTimestamp("Error during regular position check:", error);
  } finally {
    isCheckingAllPositions = false;
  }
}




// Create a rate limiter object to track last call times for each tokenId
const rateLimiter = {
  lastCallTimes: {},
  
  // Check if a tokenId can be processed now
  canProcess(tokenId) {
    const now = Date.now();
    const lastCallTime = this.lastCallTimes[tokenId] || 0;
    var fff = (10000 - (now-lastCallTime))/1000;
    //console.log("waiting: ",fff, " seconds");
    return (now - lastCallTime) >= 10000; // 10 seconds in milliseconds
  },
  
  // Mark a tokenId as processed
  markProcessed(tokenId) {
    this.lastCallTimes[tokenId] = Date.now();
  }
};


const lastCheckedAboveTwo = {}; // To track last checked time for positions with Factor > 1.5


let firstRun = true

async function setupWebSocketForus(){

    var isDifferent = await exportPoolstoCommon();
    if(firstRun || isDifferent){
        if(isDifferent){
          console.log("Different Pool Addresses must restart webSocket", isDifferent);
        }

        console.log("Setting up WebSocket for revert finance");
        firstRun = false
          setupWebsocket([
            {
              filter: v3VaultContract.filters.Add(),
              handler: async (e) => { 
                const tokenId = v3VaultContract.interface.parseLog(e).args.tokenId.toString();
                
                // Reset the last checked time for this tokenId when it's added
                lastCheckedAboveTwo[tokenId] = 0;
                
                // Perform the update on the position
                await updatePosition(tokenId);
              }
            },{
              filter: v3VaultContract.filters.Remove(),
              handler: async (e) => { 
                const tokenId = v3VaultContract.interface.parseLog(e).args.tokenId.toString();
                
                // Reset the last checked time for this tokenId when it's added
                lastCheckedAboveTwo[tokenId] = 0;
                
                // Perform the update on the position
                await updatePosition(tokenId);
              }
            },{
              filter: v3VaultContract.filters.Borrow(),
              handler: async (e) => { 
                const tokenId = v3VaultContract.interface.parseLog(e).args.tokenId;
                const tokenIdAsString = tokenId.toString();
                // Reset the last checked time for this tokenId when it's added
                lastCheckedAboveTwo[tokenIdAsString] = 0;
                
                // Perform the update on the position
                await updatePosition(tokenIdAsString);
              }
            },{
              filter: v3VaultContract.filters.Repay(),
              handler: async (e) => { 
                const tokenId = v3VaultContract.interface.parseLog(e).args.tokenId;
                
                const tokenIdAsString = tokenId.toString();
                // Reset the last checked time for this tokenId when it's added
                lastCheckedAboveTwo[tokenIdAsString] = 0;
                
                // Perform the update on the position
                await updatePosition(tokenIdAsString);
              }
            },{
              filter: v3VaultContract.filters.WithdrawCollateral(),
              handler: async (e) => { 
                const tokenId = v3VaultContract.interface.parseLog(e).args.tokenId;
                
                const tokenIdAsString = tokenId.toString();
                // Reset the last checked time for this tokenId when it's added
                lastCheckedAboveTwo[tokenIdAsString] = 0;
                
                // Perform the update on the position
                await updatePosition(tokenIdAsString);
              }
            },{
              filter: npmContract.filters.IncreaseLiquidity(),
              handler: async (e) => { 
                const tokenId = npmContract.interface.parseLog(e).args.tokenId;
                
                const tokenIdAsString = tokenId.toString();
                // Reset the last checked time for this tokenId when it's added
                lastCheckedAboveTwo[tokenIdAsString] = 0;
                
                // Perform the update on the position
                await updatePosition(tokenIdAsString);
              }
            }
          ], async function(poolAddress) {
        
            const time = new Date();

            // every 5 minutes
            if (time.getTime() > lastWSLifeCheck + 300000) {
              logWithTimestamp("WS Live check", time.toISOString());
              lastWSLifeCheck = time.getTime();
            }
          
            // IMPROVED: Use a Set to track positions we've processed in this batch
            const processedTokenIds = new Set();


            const affectedToken = getPoolToToken(asset, poolAddress);
            if (affectedToken) {
              const affectedPositionKeys = Object.keys(positions).filter(
                (key) => positions[key].token0 === affectedToken || positions[key].token1 === affectedToken
              );
          
              // Filter out positions that have been processed recently using our rate limiter
              const toCheckPositions = affectedPositionKeys
                .map((key) => positions[key])
                .filter((pos) => {
                  const tokenIdStr = pos.tokenId.toString();
                  return !processedTokenIds.has(tokenIdStr) && rateLimiter.canProcess(tokenIdStr);
                });

            toCheckPositions.map(pos => ({
              tokenId: pos.tokenId.toString(), 
              factor: pos.Factor,
              factorType: typeof pos.Factor
            }))
              // Mark these positions as processed in this batch
              toCheckPositions.forEach((pos) => {
                const tokenIdStr = pos.tokenId.toString();
                processedTokenIds.add(tokenIdStr);
              });
          
              // Remove duplicates from `toCheckPositions`
              const uniqueToCheckPositions = Array.from(
                new Map(toCheckPositions.map((pos) => [pos.tokenId.toString(), pos])).values()
              );
          
              // IMPROVED: Sort positions by Factor (if available) or by being processed last
              const sortedPositions = uniqueToCheckPositions.sort((a, b) => {
                const factorA = a.Factor !== undefined ? a.Factor : -Infinity;  // Treat undefined or null Factor as -Infinity (highest priority)
                const factorB = b.Factor !== undefined ? b.Factor : -Infinity;
          
                return factorA - factorB; // Sort by Factor (ascending)
              });
          
              // Separate positions with Factor <= 2.0, Factor > 2.0, and unset Factor
              const immediateCheckPositions = sortedPositions.filter(
                (pos) => pos.Factor === undefined || pos.Factor <= 1.1
              );
              const SeconndimmediateCheckPositions = sortedPositions.filter(
                (pos) => (pos.Factor > 1.1 && pos.Factor <= 1.5)
              );
              //console.log("immediateCheckPositions: ", immediateCheckPositions);
              const delayedCheckPositions = sortedPositions.filter((pos) => pos.Factor > 1.5);
          
              // Process immediate check positions in batches of 15
             // console.log("Normal Check now happening of lower than 1.1 Factor or undefined, batch");
              let firtTimz = false;
              for (let i = 0; i < immediateCheckPositions.length; i += 25) {
                const batch = immediateCheckPositions.slice(i, i + 25);
                if (batch.length > 0) {


                  if( batch.length && firtTimz == false){
                    firtTimz = true;
                      
                    console.log("Normal Check now happening of lower than 1.1 Factor or undefined, batch");
              
                  }


                  // Mark all tokenIds in the batch as processed in our rate limiter
                  batch.forEach((pos) => rateLimiter.markProcessed(pos.tokenId.toString()));
                
                  //console.log("Normal Check now happening of lower than 1.1 Factor or undefined, batch: ", batch);
              //   console.log("here0")
              
                  await checkPositionMULTI_FIN(batch);
              //   console.log("here1")
                  batch.forEach(pos => {
                    const tokenIdStr = pos.tokenId.toString();
                    pos.lastCheckedAboveTwo =  time.getTime();
                  });



                  await new Promise(resolve => setTimeout(resolve, 200)); //0.5 sec wait
                }
              }
          
            // console.log("here3")
              //console.log("Delayed Positions THAT MIGHT GET CHECKED: ", delayedCheckPositions);
              // Process delayed check positions (Factor > 2.0) in batches of 15
                let firstTimezzz = false
              for (let i = 0; i < SeconndimmediateCheckPositions.length; i += 25) {
                const batch = SeconndimmediateCheckPositions.slice(i, i + 25);

                if (batch.length > 0) {
                  // Check positions only if 30 minutes have passed since the last check
                  const batchToProcess = [];
                  for (const pos of batch) {
                    const tokenIdStr = pos.tokenId.toString();
                  //  console.log("ID to check: ", tokenIdStr);

                    const lastCheckTime =  pos.lastCheckedAboveTwo || 0;
                    //console.log("lastCheckedAboveTwo[tokenIdStr] :, ", lastCheckedAboveTwo[tokenIdStr] )
          
                    if (time.getTime() - lastCheckTime > 1800000) { // 30 minutes = 1800000 ms
                      // Mark the position as processed and update the last check time
                      pos.lastCheckedAboveTwo = time.getTime();
                      batchToProcess.push(pos);
                    }
                  }
          
                  if (batchToProcess.length > 0) {
                    
                    if( batchToProcess.length > 0 && firstTimezzz == false){
                      firstTimezzz = true;
                        
                    console.log("Delayed Positions WILL now GET CHECKED of GREATER THAN 1.1 but less than 1.5 Factor");
  
                    }


            
                    // Mark all tokenIds in the batch as processed in our rate limiter
                    batchToProcess.forEach((pos) => rateLimiter.markProcessed(pos.tokenId.toString()));
          
                //    console.log("Delayed Positions WILL now GET CHECKED of GREATER THAN 1.1 but less than 1.5 Factor");
                    await checkPositionMULTI_FIN(batchToProcess); 
                    await new Promise(resolve => setTimeout(resolve, 2000)); //2 sec wait

                  }
                }
              }

              let firstimezzz = false;
              //console.log("Delayed Positions THAT MIGHT GET CHECKED: ", delayedCheckPositions);
              // Process delayed check positions (Factor > 2.0) in batches of 15
              for (let i = 0; i < delayedCheckPositions.length; i += 25) {
                const batch = delayedCheckPositions.slice(i, i + 25);

                if (batch.length > 0) {
                  // Check positions only if 30 minutes have passed since the last check
                  const batchToProcess = [];
                  for (const pos of batch) {
                      const tokenIdStr = pos.tokenId.toString();
                      // console.log("ID to check: ", tokenIdStr);
                      const lastCheckTime =  pos.lastCheckedAboveTwo || 0;
                      //console.log("lastCheckedAboveTwo[tokenIdStr] :, ", lastCheckedAboveTwo[tokenIdStr] )
            
                      if (time.getTime() - lastCheckTime > 7200000) { // 120 minutes = 7200000 ms
                        // Mark the position as processed and update the last check time
                            pos.lastCheckedAboveTwo = time.getTime();
                            batchToProcess.push(pos);
                        }
                    }
          
                  if (batchToProcess.length > 0) {
                    
                    
                          if( batchToProcess.length > 0 && firstimezzz == false){
                              firstimezzz = true;
                              console.log("Delayed Positions WILL now GET CHECKED of GREATER THAN 1.5 Factor");
                              
                          }
                    // Mark all tokenIds in the batch as processed in our rate limiter
                    batchToProcess.forEach((pos) => rateLimiter.markProcessed(pos.tokenId.toString()));
          
                  //  console.log("Delayed Positions WILL now GET CHECKED of GREATER THAN 1.5 Factor");
                    await checkPositionMULTI_FIN(batchToProcess);
                    
                    await new Promise(resolve => setTimeout(resolve, 4000)); //4 sec wait for new getCurrentBlock();
                  }
                }
              }


              
            }
          

        })

        }
}



async function run() {
  
  registerErrorHandler()

  asset = (await v3VaultContract.asset()).toLowerCase()
  assetDecimals = await getTokenDecimals(asset)
  assetSymbol = await getTokenSymbol(asset)

  await updateDebtExchangeRate()

  await loadPositions()
  // setup websockets for monitoring changes to positions
  //await loadPositions()
  //await exportPoolstoCommon()

  await setupWebSocketForus()

  setInterval(async () => { await saveActivePositions() }, 5.003*60*1000)
  //setInterval(async () => { await exportPoolstoCommon() }, 1*60*1000)
  setInterval(async () => { await setupWebSocketForus() }, 1*60*1000)
  
  setInterval(async () => { await updateDebtExchangeRate() }, 60000)

  // Set up regular interval checks
  const CHECK_INTERVAL = 50 * 60 * 1000; // 15 minutes in milliseconds
  setInterval(async () => {
  //  await checkAllPositions();
  await checkAllPositionsAtOnce();
  }, CHECK_INTERVAL);

  process.on('SIGINT', () => {
    logWithTimestamp('Received SIGINT. Shutting down gracefully...');
    // Close any open connections, stop any ongoing operations
    process.exit(0);
  });
}


logWithTimestampAndSveToFile("Starting Revert Liquidator");
run()
