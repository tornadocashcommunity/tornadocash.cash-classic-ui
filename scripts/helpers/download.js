import fs from 'fs'
import Jszip from 'jszip'
import Web3 from 'web3'
import networkConfig from '../../networkConfig'

const jszip = new Jszip()

export async function download({ name, directory, contentType }) {
  const path = `${directory}${name}.zip`.toLowerCase()

  const data = fs.readFileSync(path)
  const zip = await jszip.loadAsync(data)

  const file = zip.file(
    path
      .replace(directory, '')
      .slice(0, -4)
      .toLowerCase()
  )

  const content = await file.async(contentType)

  return content
}

export async function loadCachedEvents({ name, directory, deployedBlock }) {
  try {
    const module = await download({ contentType: 'string', directory, name })

    if (module) {
      const events = JSON.parse(module)

      return {
        events,
        lastBlock:  events[events.length - 1].blockNumber
      }
    }
  } catch (err) {
    console.error(`Method loadCachedEvents has error: ${err.message}`)
    return {
      events: [],
      lastBlock: deployedBlock
    }
  }
}

export async function getPastEvents({ type, fromBlock, netId, events, contractAttrs }) {
  let downloadedEvents = events

  let [{ url: rpcUrl }] = Object.values(networkConfig[`netId${netId}`].rpcUrls)

  if (netId === '5') {
    rpcUrl = 'https://goerli.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161'
  }

  const provider = new Web3.providers.HttpProvider(rpcUrl)
  const web3 = new Web3(provider)
  const contract = new web3.eth.Contract(...contractAttrs)

  const currentBlockNumber = await web3.eth.getBlockNumber()
  // PoS networks index blocks too fast, so a buffer is needed
  const blockNumberBuffer = currentBlockNumber - 3
  const blockDifference = Math.ceil(blockNumberBuffer - fromBlock)

  // eth_logs and eth_filter are restricted > 10,000 block queries
  const blockRange = 10000

  let chunksCount = blockDifference === 0 ? 1 : Math.ceil(blockDifference / blockRange)
  const chunkSize = Math.ceil(blockDifference / chunksCount)

  let toBlock = fromBlock + chunkSize

  if (fromBlock < currentBlockNumber) {
    if (toBlock >= currentBlockNumber) {
      toBlock = currentBlockNumber
      chunksCount = 1
    }

    console.log(`Fetching ${type}, chainId - ${netId}`, `chunksCount - ${chunksCount}`)
    for (let i = 0; i < chunksCount; i++)
      try {
        await new Promise((resolve) => setTimeout(resolve, 200))

        console.log(`fromBlock - ${fromBlock}`)
        console.log(`toBlock - ${toBlock}`)

        const eventsChunk = await contract.getPastEvents(type, { fromBlock, toBlock })

        if (eventsChunk) {
          downloadedEvents = downloadedEvents.concat(eventsChunk)
          console.log('downloaded events count - ', eventsChunk.length)
          console.log('____________________________________________')
        }
        fromBlock = toBlock
        toBlock += chunkSize
      } catch (err) {
        console.log('getPastEvents events', `chunk number - ${i}, has error: ${err.message}`)
      }
  }
  return downloadedEvents
}
