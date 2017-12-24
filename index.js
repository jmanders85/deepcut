const https = require('https')
const fs = require('fs')
const { parseString } = require('xml2js');
const { series } = require('async')
const _range = require('lodash/range')
const _flatten = require('lodash/flatten')

const START_DATE = '2017-12-01'
const END_DATE = '2017-12-31'
const NUMBER_OF_GAMES_TO_LIST = 12

const THROTTLE = 2000 // BGG API is rate limited, this number seems to be the fastest I can get away with

const MEMBERS_PER_PAGE = 25
const GUILD_URI = 'https://www.boardgamegeek.com/xmlapi2/guild?id=2708&members=1&sort=date'
const PLAYS_URI = user => `https://www.boardgamegeek.com/xmlapi2/plays?username=${user}&mindate=${START_DATE}&maxdate=${END_DATE}`

const FILE_NAME = 'members.csv'
const FILE_OPTIONS = { encoding: 'utf-8' }
const DELIMETER = '|'

let memebersWithNoPlaysThisPeriod = 0

const [
  previousCount,
  previousDate,
  ...previousMembers
] = fs.readFileSync(FILE_NAME, FILE_OPTIONS).split(DELIMETER)

https.get(GUILD_URI, res => {
  let body = ''

  res.on('data', d => body += d)

  res.on('end', () => {
    parseString(body, (err, result) => {
      if (err) throw err
      
      const members = result.guild.members[0]

      const memberCount = members.$.count
      const latestJoin = members.member[0].$.date
      const first25Members = members.member

      if (memberCount !== previousCount || latestJoin !== previousDate) {
        console.log('\nUpdating Member List\n')

        getRestOfMembersAndWriteFile(memberCount, latestJoin, first25Members)
      } else {
        console.log('\nNo changes in Member list detected\n')

        getMemberPlaysForMonth(previousMembers)
      }
    })
  })
})

function getRestOfMembersAndWriteFile(memberCount, latestJoin, first25Members) {
  const pages = Math.ceil(memberCount / MEMBERS_PER_PAGE)
  const pageRange = _range(2, pages + 1)

  let newMembers = first25Members.map(mem => mem.$.name)

  series(
    pageRange.map(page => {
      return cb => {
        setTimeout(() => {
          console.log('Fetching page', page, 'of', pages)

          https.get(`${GUILD_URI}&page=${page}`, pageResult => {
            let body = ''

            pageResult.on('data', d => body += d)

            pageResult.on('end', () => {
              parseString(body, (err, result) => {
                cb(err, result)
              })
            })
          })
        }, THROTTLE)
      }
    }),
    (err, results) => {
      if (err) throw err

      newMembers = results.reduce((list, result) => [
        ...list,
        ...result.guild.members[0].member.map(mem => mem.$.name)
      ], newMembers)

      fs.writeFileSync(
        FILE_NAME,
        [memberCount, latestJoin, ...newMembers].join(DELIMETER),
        FILE_OPTIONS
      )

      getMemberPlaysForMonth(newMembers)
    }
  )
}

function getMemberPlaysForMonth(memberList) {
  const numberOfMembers = memberList.length

  series(
    memberList.map((member, i) => {
      return cb => {
        setTimeout(() => {
          console.log('Fetching plays for', member, 'Number', i + 1, 'of', numberOfMembers)
          https.get(PLAYS_URI(member), memberResult => {
            let body = ''

            memberResult.on('data', d => body += d)

            memberResult.on('end', () => {
              parseString(body, (err, result) => {
                const { total } = result.plays.$

                if (total > 100) {
                  const gamePages = Math.ceil(total / 100)
                  const gamePageRange = _range(2, gamePages + 1)

                  series(
                    gamePageRange.map(page => {
                      return pageCb => {
                        setTimeout(() => {
                          console.log('Getting page', page, 'of', member, 'plays')

                          https.get(`${PLAYS_URI(member)}&page=${page}`, pageResult => {
                            let body = ''

                            pageResult.on('data', d => body += d)

                            pageResult.on('end', () => {
                              parseString(body, (err, pageParseResult) => {
                                pageCb(err, pageParseResult.plays.play)
                              })
                            })
                          })
                        }, THROTTLE)
                      }
                    }),
                    (err, morePlays) => {
                      cb(err, { member, plays: _flatten(morePlays) })
                    }
                  )
                } else {
                  const plays = result.plays.play || []

                  if (plays.length === 0) memebersWithNoPlaysThisPeriod++

                  cb(err, { member, plays })
                }
              })
            })
          })
        }, THROTTLE)
      }
    }),
    (err, result) => {
      if (err) throw err

      const gamesPlayed = result.reduce((acc, { member, plays }) => {
        return plays.reduce((games, play) => {
          const { quantity } = play.$
          const { name } = play.item[0].$

          if (games[name]) {
            const peopleWhoHavePlayedThis = games[name].members

            return {
              ...games,
              [name]: {
                members: peopleWhoHavePlayedThis.includes(member)
                  ? peopleWhoHavePlayedThis
                  : [...peopleWhoHavePlayedThis, member],
                quantity: games[name].quantity + +quantity,
              }
            }
          }

          return {
            ...games,
            [name]: {
              members: [member],
              quantity: +quantity,
            }
          };
        }, acc)
      }, {})

      const gameNames = Object.keys(gamesPlayed).sort((a, b) => {
        const gameA = gamesPlayed[a]
        const gameB = gamesPlayed[b]

        if (gameA.members.length > gameB.members.length) {
          return -1
        }

        if (gameA.members.length === gameB.members.length) {
          if (gameA.quantity > gameB.quantity) {
            return -1
          }
        }

        return 1
      })

      console.log(`\nFor the period ${START_DATE} to ${END_DATE}:`)

      const longest = gameNames.slice(0, NUMBER_OF_GAMES_TO_LIST).reduce((a, e) => {
        const nameLength = e.length
        const gamePlays = numberLength(gamesPlayed[e].quantity)

        return {
          ...a,
          gameName: nameLength > a.gameName ? nameLength : a.gameName,
          plays: gamePlays > a.plays ? gamePlays : a.plays,
        }
      }, {
        gameName: 0,
        members: numberLength(gamesPlayed[gameNames[0]].members.length),
        plays: 0,
      });

      _range(0, NUMBER_OF_GAMES_TO_LIST).forEach(i => {
        const game = gameNames[i]
        const { quantity } = gamesPlayed[game]
        const members = gamesPlayed[game].members.length
        console.log(
          `${i < 9 ? ' ' : ''}${i + 1}. ${game}${' '.repeat(longest.gameName - game.length)} played by ${' '.repeat(longest.members - numberLength(members))}${members} members ${' '.repeat(longest.plays - numberLength(quantity))}${quantity} times`)
      })

      console.log(`\n${numberOfMembers - memebersWithNoPlaysThisPeriod} members with recorded plays`)
    }
  )
}

function numberLength(number) {
  return Math.floor(Math.log10(number)) + 1
}
