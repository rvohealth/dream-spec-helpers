import provideDreamViteMatchers from "../src/viteMatchers.js"

// Stand-ins for Dream models. The matchers receive the Dream base class by
// injection and look at a model only through `instanceof Dream`, its
// constructor, `primaryKeyValue()` and `comparisonKey` (built the way
// @rvoh/dream builds it: `<globalName>:<primary key>`), so these specs need
// neither @rvoh/dream nor a database.
class Dream {
  constructor(private id: number) {}

  static get globalName() {
    return this.name
  }

  primaryKeyValue() {
    return this.id
  }

  get comparisonKey() {
    return `${(this.constructor as typeof Dream).globalName}:${this.primaryKeyValue()}`
  }
}

class Place extends Dream {}
class Balloon extends Dream {}

provideDreamViteMatchers(Dream)

const place1 = new Place(1)
const place2 = new Place(2)
const place3 = new Place(3)
const balloon1 = new Balloon(1)

describe("toMatchDreamModels", () => {
  context("when every pair matches", () => {
    it("passes, whatever the order of either array", () => {
      expect([place1, place2, place3]).toMatchDreamModels([
        place3,
        place1,
        place2,
      ])
    })

    it("passes when models of different classes share a primary key", () => {
      expect([place1, balloon1]).toMatchDreamModels([balloon1, place1])
    })

    it("fails when negated", () => {
      expect(() =>
        expect([place1, place3]).not.toMatchDreamModels([place3, place1]),
      ).toThrow("Expected arrays of Dream objects not to match, but they do")
    })
  })

  context("when a pair before the last has a different primary key", () => {
    it("fails", () => {
      expect(() =>
        expect([place2, place3]).toMatchDreamModels([place1, place3]),
      ).toThrow(
        "expected is Place with primary key 1\nreceived is Place with primary key 2",
      )
    })

    it("passes when negated", () => {
      expect([place2, place3]).not.toMatchDreamModels([place1, place3])
    })
  })

  context("when only the last pair matches", () => {
    it("fails", () => {
      expect(() =>
        expect([place1, place2, place3]).toMatchDreamModels([
          place3,
          place3,
          place3,
        ]),
      ).toThrow(
        "expected is Place with primary key 3\nreceived is Place with primary key 1",
      )
    })

    it("passes when negated", () => {
      expect([place1, place2, place3]).not.toMatchDreamModels([
        place3,
        place3,
        place3,
      ])
    })
  })

  context("when the first pair has a different class", () => {
    it("fails", () => {
      expect(() =>
        expect([balloon1, place3]).toMatchDreamModels([place1, place3]),
      ).toThrow("expected Place, received Balloon")
    })

    it("passes when negated", () => {
      expect([balloon1, place3]).not.toMatchDreamModels([place1, place3])
    })
  })

  context("when the last pair has a different primary key", () => {
    it("fails", () => {
      expect(() =>
        expect([place1, place2]).toMatchDreamModels([place1, place3]),
      ).toThrow(
        "expected is Place with primary key 3\nreceived is Place with primary key 2",
      )
    })

    it("passes when negated", () => {
      expect([place1, place2]).not.toMatchDreamModels([place1, place3])
    })
  })

  context("with one model on each side", () => {
    it("passes when they match", () => {
      expect([place1]).toMatchDreamModels([place1])
    })

    it("fails when they differ", () => {
      expect(() => expect([place1]).toMatchDreamModels([place2])).toThrow(
        "expected is Place with primary key 2\nreceived is Place with primary key 1",
      )
    })
  })

  context("with two empty arrays", () => {
    it("passes", () => {
      expect([]).toMatchDreamModels([])
    })

    it("fails when negated", () => {
      expect(() => expect([]).not.toMatchDreamModels([])).toThrow(
        "Expected arrays not to match, but both were empty",
      )
    })
  })

  context("with arrays of different lengths", () => {
    it("fails", () => {
      expect(() =>
        expect([place1]).toMatchDreamModels([place1, place2]),
      ).toThrow(
        "Expected arrays of the same length, but expected has 2 elements and received has 1",
      )
    })

    it("passes when negated", () => {
      expect([place1]).not.toMatchDreamModels([place1, place2])
    })
  })
})
