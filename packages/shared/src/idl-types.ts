/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/escrow.json`.
 */
export type Escrow = {
  "address": "nqQkfoyxtzxDBHmyxnJs3KwQVvz5CoFffH8vcQzS6yt",
  "metadata": {
    "name": "escrow",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Cozy Bet peer-to-peer escrow"
  },
  "instructions": [
    {
      "name": "arbiterResolve",
      "docs": [
        "Arbiter forces a resolution. Arbiter fee = max(arbiter_min_fee,",
        "pot * arbiter_fee_bps_of_pot / 10000), paid to msg.sender (arbiter ATA).",
        "Arbiter must equal config.arbiter."
      ],
      "discriminator": [
        72,
        74,
        145,
        98,
        97,
        32,
        107,
        5
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "bet",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  101,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "betId"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "betId"
              }
            ]
          }
        },
        {
          "name": "winnerAta",
          "writable": true
        },
        {
          "name": "treasuryAta0",
          "writable": true
        },
        {
          "name": "treasuryAta1",
          "writable": true
        },
        {
          "name": "treasuryAta2",
          "writable": true
        },
        {
          "name": "treasuryAta3",
          "writable": true
        },
        {
          "name": "arbiterAta",
          "writable": true
        },
        {
          "name": "arbiter",
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "betId",
          "type": "u64"
        },
        {
          "name": "winner",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "deposit",
      "docs": [
        "Either participant deposits their stake. Caller must be challenger or accepter."
      ],
      "discriminator": [
        242,
        35,
        198,
        137,
        82,
        225,
        242,
        182
      ],
      "accounts": [
        {
          "name": "bet",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  101,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "betId"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "betId"
              }
            ]
          }
        },
        {
          "name": "depositorAta",
          "writable": true
        },
        {
          "name": "depositor",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "betId",
          "type": "u64"
        }
      ]
    },
    {
      "name": "draw",
      "docs": [
        "Both sides agreed it's a draw. Refund full stakes. No fee."
      ],
      "discriminator": [
        61,
        40,
        62,
        184,
        31,
        176,
        24,
        130
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "bet",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  101,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "betId"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "betId"
              }
            ]
          }
        },
        {
          "name": "challengerAta",
          "writable": true
        },
        {
          "name": "accepterAta",
          "writable": true
        },
        {
          "name": "resolver",
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "betId",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initializeBet",
      "docs": [
        "Create a bet. Resolver signs. `terms_hash` is keccak256/sha256 of the",
        "canonical (chat-disambig-agreed) bet terms; pass [0u8; 32] for legacy",
        "flows that skip the terms-signing step."
      ],
      "discriminator": [
        195,
        185,
        122,
        189,
        203,
        104,
        43,
        57
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "bet",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  101,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "betId"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "betId"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "resolver",
          "signer": true
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "betId",
          "type": "u64"
        },
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "challenger",
          "type": "pubkey"
        },
        {
          "name": "accepter",
          "type": "pubkey"
        },
        {
          "name": "termsHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "initializeConfig",
      "docs": [
        "One-time setup. After this, treasury is split 4 ways, resolver signs",
        "`resolve`/`draw`/`refund`/`set_fee_bps_for_side`, arbiter signs",
        "`arbiter_resolve`. Admin (authority) can rotate any of these later."
      ],
      "discriminator": [
        208,
        127,
        21,
        1,
        194,
        190,
        196,
        70
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "treasuryOwners",
          "type": {
            "array": [
              "pubkey",
              4
            ]
          }
        },
        {
          "name": "resolver",
          "type": "pubkey"
        },
        {
          "name": "arbiter",
          "type": "pubkey"
        },
        {
          "name": "defaultFeeBps",
          "type": "u16"
        },
        {
          "name": "minDiscountedFeeBps",
          "type": "u16"
        },
        {
          "name": "arbiterMinFee",
          "type": "u64"
        },
        {
          "name": "arbiterFeeBpsOfPot",
          "type": "u16"
        }
      ]
    },
    {
      "name": "refund",
      "docs": [
        "Refund whatever was deposited (one or both sides). Used on mutual cancel."
      ],
      "discriminator": [
        2,
        96,
        183,
        251,
        63,
        208,
        46,
        46
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "bet",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  101,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "betId"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "betId"
              }
            ]
          }
        },
        {
          "name": "challengerAta",
          "writable": true
        },
        {
          "name": "accepterAta",
          "writable": true
        },
        {
          "name": "resolver",
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "betId",
          "type": "u64"
        }
      ]
    },
    {
      "name": "resolve",
      "docs": [
        "Resolver pays winner: pot − standard_fee. Standard fee = sum of",
        "per-side fee bps applied to each side's stake; split evenly across the",
        "4 treasury owner ATAs (remainder goes to slot 0)."
      ],
      "discriminator": [
        246,
        150,
        236,
        206,
        108,
        63,
        58,
        10
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "bet",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  101,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "betId"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "betId"
              }
            ]
          }
        },
        {
          "name": "winnerAta",
          "writable": true
        },
        {
          "name": "treasuryAta0",
          "writable": true
        },
        {
          "name": "treasuryAta1",
          "writable": true
        },
        {
          "name": "treasuryAta2",
          "writable": true
        },
        {
          "name": "treasuryAta3",
          "writable": true
        },
        {
          "name": "resolver",
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "betId",
          "type": "u64"
        },
        {
          "name": "winner",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setFeeBpsForSide",
      "docs": [
        "Reduce a participant's per-side fee bps. Resolver-only. Floor at",
        "`min_discounted_fee_bps`. Cannot increase. Used to apply the social-share",
        "discount (250 → 150 typically)."
      ],
      "discriminator": [
        214,
        123,
        25,
        171,
        145,
        75,
        30,
        154
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "bet",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  101,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "betId"
              }
            ]
          }
        },
        {
          "name": "resolver",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "betId",
          "type": "u64"
        },
        {
          "name": "side",
          "type": "pubkey"
        },
        {
          "name": "newBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "updateAuthority",
      "docs": [
        "Admin-only. Hand off the program authority to a new pubkey (e.g. a",
        "Squads multisig vault). Single-step rotation: the current authority",
        "signs, the new authority is recorded immediately. Multisig approval",
        "gating is provided by Squads (or whatever wallet signs the tx) — the",
        "program just verifies the *current* authority signed."
      ],
      "discriminator": [
        32,
        46,
        64,
        28,
        149,
        75,
        243,
        88
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "authority",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "newAuthority",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "updateConfig",
      "docs": [
        "Admin-only. Pass `None` to keep an existing field."
      ],
      "discriminator": [
        29,
        158,
        252,
        191,
        10,
        83,
        219,
        99
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "authority",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "treasuryOwners",
          "type": {
            "option": {
              "array": [
                "pubkey",
                4
              ]
            }
          }
        },
        {
          "name": "resolver",
          "type": {
            "option": "pubkey"
          }
        },
        {
          "name": "arbiter",
          "type": {
            "option": "pubkey"
          }
        },
        {
          "name": "defaultFeeBps",
          "type": {
            "option": "u16"
          }
        },
        {
          "name": "minDiscountedFeeBps",
          "type": {
            "option": "u16"
          }
        },
        {
          "name": "arbiterMinFee",
          "type": {
            "option": "u64"
          }
        },
        {
          "name": "arbiterFeeBpsOfPot",
          "type": {
            "option": "u16"
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "bet",
      "discriminator": [
        147,
        23,
        35,
        59,
        15,
        75,
        155,
        32
      ]
    },
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "feeTooHigh",
      "msg": "Fee basis points must be <= 10000"
    },
    {
      "code": 6001,
      "name": "amountMustBePositive",
      "msg": "Amount must be > 0"
    },
    {
      "code": 6002,
      "name": "sameParticipants",
      "msg": "Challenger and accepter must differ"
    },
    {
      "code": 6003,
      "name": "invalidState",
      "msg": "Bet is not in a valid state for this action"
    },
    {
      "code": 6004,
      "name": "notAParticipant",
      "msg": "Signer is not a participant in this bet"
    },
    {
      "code": 6005,
      "name": "alreadyDeposited",
      "msg": "Participant already deposited"
    },
    {
      "code": 6006,
      "name": "wrongMint",
      "msg": "Deposit ATA uses the wrong mint"
    },
    {
      "code": 6007,
      "name": "ataMismatch",
      "msg": "ATA owner does not match expected wallet"
    },
    {
      "code": 6008,
      "name": "winnerNotParticipant",
      "msg": "Winner must be a participant"
    },
    {
      "code": 6009,
      "name": "winnerAtaMismatch",
      "msg": "Winner ATA owner mismatch"
    },
    {
      "code": 6010,
      "name": "treasuryAtaMismatch",
      "msg": "Treasury ATA owner mismatch"
    },
    {
      "code": 6011,
      "name": "unauthorizedResolver",
      "msg": "Signer is not the authorized resolver"
    },
    {
      "code": 6012,
      "name": "unauthorizedArbiter",
      "msg": "Signer is not the authorized arbiter"
    },
    {
      "code": 6013,
      "name": "unauthorizedAdmin",
      "msg": "Signer is not the config admin"
    },
    {
      "code": 6014,
      "name": "mathOverflow",
      "msg": "Math overflow"
    },
    {
      "code": 6015,
      "name": "zeroAddress",
      "msg": "Pubkey cannot be the zero address"
    },
    {
      "code": 6016,
      "name": "potTooSmallForArbiter",
      "msg": "Pot too small to cover arbiter + standard fees"
    },
    {
      "code": 6017,
      "name": "invalidFeeBps",
      "msg": "Invalid fee bps"
    }
  ],
  "types": [
    {
      "name": "bet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "betId",
            "type": "u64"
          },
          {
            "name": "challenger",
            "type": "pubkey"
          },
          {
            "name": "accepter",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "challengerDeposited",
            "type": "bool"
          },
          {
            "name": "accepterDeposited",
            "type": "bool"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "betStatus"
              }
            }
          },
          {
            "name": "winner",
            "type": "pubkey"
          },
          {
            "name": "challengerFeeBps",
            "type": "u16"
          },
          {
            "name": "accepterFeeBps",
            "type": "u16"
          },
          {
            "name": "termsHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "betStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "pending"
          },
          {
            "name": "funded"
          },
          {
            "name": "resolved"
          },
          {
            "name": "drawn"
          },
          {
            "name": "refunded"
          }
        ]
      }
    },
    {
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "treasuryOwners",
            "type": {
              "array": [
                "pubkey",
                4
              ]
            }
          },
          {
            "name": "resolver",
            "type": "pubkey"
          },
          {
            "name": "arbiter",
            "type": "pubkey"
          },
          {
            "name": "defaultFeeBps",
            "type": "u16"
          },
          {
            "name": "minDiscountedFeeBps",
            "type": "u16"
          },
          {
            "name": "arbiterMinFee",
            "type": "u64"
          },
          {
            "name": "arbiterFeeBpsOfPot",
            "type": "u16"
          }
        ]
      }
    }
  ]
};
