import 'dotenv/config'

import fs from 'fs'
import { uniqBy } from 'lodash'

import networkConfig, { enabledChains } from '../networkConfig'
import ABI from '../abis/Instance.abi.json'

import { loadCachedEvents, getPastEvents } from './helpers'

const EVENTS_PATH = './static/events/'
const EVENTS = ['Deposit', 'Withdrawal']

async function main(type, netId, chosenToken) {
  const { tokens, nativeCurrency, deployedBlock } = networkConfig[`netId${netId}`]
  const token = chosenToken !== undefined ? chosenToken : nativeCurrency

  const CONTRACTS = tokens[token].instanceAddress

  for (const [instance, _contract] of Object.entries(CONTRACTS)) {
    const cachedEvents = loadCachedEvents({
      name: `${type.toLowerCase()}s_${netId}_${token}_${instance}.json`,
      directory: EVENTS_PATH,
      deployedBlock
    })

    console.log('Update events for', instance, token.toUpperCase(), `${type.toLowerCase()}s`)
    console.log('cachedEvents count - ', cachedEvents.events.length)
    console.log('lastBlock - ', cachedEvents.lastBlock)

    let events = []

    events = await getPastEvents({
      type,
      netId,
      events,
      contractAttrs: [ABI, _contract],
      fromBlock: cachedEvents.lastBlock + 1
    })

    if (type === 'Deposit') {
      events = events.map(({ blockNumber, transactionHash, returnValues }) => {
        const { commitment, leafIndex, timestamp } = returnValues
        return {
          timestamp,
          commitment,
          blockNumber,
          transactionHash,
          leafIndex: Number(leafIndex)
        }
      })
    }

    if (type === 'Withdrawal') {
      events = events.map(({ blockNumber, transactionHash, returnValues }) => {
        const { nullifierHash, to, fee } = returnValues
        return {
          to,
          fee,
          blockNumber,
          nullifierHash,
          transactionHash
        }
      })
    }

    let freshEvents = cachedEvents.events.concat(events)

    if (type === 'Withdrawal') {
      freshEvents = uniqBy(freshEvents, 'nullifierHash').sort((a, b) => a.blockNumber - b.blockNumber)
    } else {
      freshEvents = freshEvents.filter((e, index) => Number(e.leafIndex) === index)
    }

    const eventsJson = JSON.stringify(freshEvents, null, 2) + '\n'

    fs.writeFileSync(`${EVENTS_PATH}${type.toLowerCase()}s_${netId}_${token}_${instance}.json`, eventsJson)
  }
}

async function start() {
  const [, , , chain, chosenToken] = process.argv

  if (!enabledChains.includes(chain)) {
    throw new Error(`Supported chain ids ${enabledChains.join(', ')}`)
  }

  for (const event of EVENTS) {
    await main(event, chain, chosenToken)
  }
}

start()
