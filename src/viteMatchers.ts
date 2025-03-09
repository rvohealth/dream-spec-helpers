import { expect } from "vitest"
import sortBy from "./sortBy.js"

function ERROR_COLOR(message: string) {
  return message
}

function RECEIVED_COLOR(message: string) {
  return message
}

function EXPECTED_COLOR(message: string) {
  return message
}

function matcherHint(message: string) {
  return message
}

function printExpected(message: string) {
  return message
}

function printReceived(message: string) {
  return message
}

function stringify(message: unknown) {
  return JSON.parse(JSON.stringify(message))
}

interface CustomMatcherResult {
  pass: boolean
  message: (actual?: unknown) => string
}

declare module "vitest" {
  interface ExpectStatic {
    toMatchDreamModel(expected: any): CustomMatcherResult
    toMatchDreamModels(expected: any): CustomMatcherResult
    toBeWithin(precision: number, expected: number): CustomMatcherResult
    toEqualCalendarDate(expected: any): CustomMatcherResult
  }

  interface Assertion {
    toMatchDreamModel(expected: any): CustomMatcherResult
    toMatchDreamModels(expected: any): CustomMatcherResult
    toBeWithin(precision: number, expected: number): CustomMatcherResult
    toEqualCalendarDate(expected: any): CustomMatcherResult
  }
}

export default function provideDreamViteMatchers() {
  expect.extend({
    toEqualCalendarDate(received: any, expected: any) {
      if (!(received?.constructor?.name === "CalendarDate")) {
        return {
          pass: false,
          message: () =>
            `Expected received object to be an calendarDate, but was ${received?.constructor?.name}`,
        }
      }

      const pass = expected.equals(received)
      return {
        pass,
        message: () =>
          pass
            ? `expected ${received.toISO()} NOT to equal ${expected.toISO()}`
            : `expected ${received.toISO()} to equal ${expected.toISO()}`,
      }
    },

    // https://stackoverflow.com/questions/50896753/jest-tobeclosetos-precision-not-working-as-expected#answer-75639525
    toBeWithin(received: any, precision: number, expected: number) {
      if (typeof received !== "number") {
        throw new TypeError(`Received ${typeof received}, but expected number`)
      }

      const pass = Math.abs(received - expected) < precision
      return {
        pass,
        message: () =>
          pass
            ? `expected ${received} NOT to be within ${precision} of ${expected}`
            : `expected ${received} to be within ${precision} of ${expected}`,
      }
    },

    toMatchDreamModel(received: any, expected: any) {
      return expectMatchingDreamModels(received, expected, "toMatchDreamModel")
    },

    toMatchDreamModels(received: any, expected: any) {
      if (!Array.isArray(received)) {
        return {
          pass: false,
          message: () =>
            `Expected received object to be an Array, but was ${received?.constructor?.name}`,
        }
      } else if (!Array.isArray(expected)) {
        return {
          pass: false,
          message: () =>
            `Expected expected object to be an Array, but was ${expected?.constructor?.name}`,
        }
      } else if (expected.length != received.length) {
        return {
          pass: false,
          message: () =>
            `Expected arrays of the same length, but expected has ${expected.length} elements and received has ${received.length}`,
        }
      } else if (expected.length === 0) {
        return {
          pass: true,
          message: () => "Expected arrays not to match, but both were empty",
        }
      }

      let results: CustomMatcherResult

      received = sortBy(received, (a) => a[received[0]?.primaryKey])
      expected = sortBy(expected, (a) => a[expected[0]?.primaryKey])

      received.forEach((receivedElement: any, i: number) => {
        results = expectMatchingDreamModels(
          receivedElement,
          expected[i],
          "toMatchDreamModels",
        )
        if (!results.pass) return
      })

      if (results!.pass) {
        return {
          pass: true,
          message: () =>
            "Expected arrays of Dream objects not to match, but they do",
        }
      } else {
        return results!
      }
    },
  })
}

function attributes(obj: any) {
  return { instanceof: obj.constructor.name, ...obj.attributes }
}

export function expectMatchingDreamModels(
  received: any,
  expected: any,
  matcherName: string,
): CustomMatcherResult {
  let pass: boolean = false
  let message: () => string

  if (expected === undefined) {
    message = () => "expected is undefined but should be an instance of Dream"
  } else if (expected === null) {
    message = () =>
      ERROR_COLOR("expected is null but should be an instance of Dream")
  } else if (typeof expected !== "object") {
    message = () =>
      ERROR_COLOR(
        `expected is ${expected.constructor.name} but must be an instance of Dream`,
      )
  } else if (received === undefined) {
    message = () =>
      ERROR_COLOR("received is undefined but should be an instance of Dream")
  } else if (received === null) {
    message = () =>
      ERROR_COLOR("received is null but should be an instance of Dream")
  } else if (typeof received !== "object") {
    message = () =>
      ERROR_COLOR(
        `received is ${received.constructor.name} but must be an instance of Dream`,
      )
  } else if (expected.constructor !== received.constructor) {
    message = () =>
      EXPECTED_COLOR(`expected ${expected.constructor.name}, `) +
      RECEIVED_COLOR(`received ${received.constructor.name}`)
  } else if (expected.primaryKeyValue !== received.primaryKeyValue) {
    message = () =>
      EXPECTED_COLOR(
        `expected is ${expected.constructor.name} with primary key ${expected.primaryKeyValue}\n`,
      ) +
      RECEIVED_COLOR(
        `received is ${received.constructor.name} with primary key ${received.primaryKeyValue}`,
      )
  } else {
    const comparableReceived = attributes(received)
    const comparableExpected = attributes(expected)
    pass =
      JSON.stringify(comparableReceived) === JSON.stringify(comparableExpected)

    message = pass
      ? () =>
          matcherHint(matcherName) +
          "\n\n" +
          `Expected: not ${printExpected(comparableExpected)}` +
          (stringify(comparableExpected) !== stringify(comparableReceived)
            ? `\nReceived:     ${printReceived(comparableReceived)}`
            : "")
      : () =>
          matcherHint(matcherName) +
          "\n\n" +
          generateDiff(comparableExpected, comparableReceived)
  }

  return { message, pass }
}

// provided by chatgpt
function generateDiff(expected: any, received: any): string {
  const diffLines: string[] = []

  // Compare keys in the expected object
  for (const key in expected) {
    if (expected.hasOwnProperty(key)) {
      if (expected[key] !== received[key]) {
        diffLines.push(`- Expected ${key}: ${expected[key]}`)
        diffLines.push(`+ Received ${key}: ${received[key]}`)
      }
    }
  }

  // Compare keys in the received object
  for (const key in received) {
    if (received.hasOwnProperty(key) && !expected.hasOwnProperty(key)) {
      diffLines.push(`+ Received ${key}: ${received[key]}`)
    }
  }

  return diffLines.join("\n")
}
