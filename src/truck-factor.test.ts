import { describe, expect, it } from "vitest";
import { computeTruckFactor, type ContributorStat } from "./truck-factor.js";

/**
 * Fixtures are hand-built to reproduce the *shape* of real GitHub
 * `/stats/contributors` responses. The expected truck factors and top-author
 * shares below match the values verified against the live API and recorded in
 * ADR-0001.
 */
const contributor = (
  login: string | null,
  total: number,
  lines?: { additions: number; deletions: number },
): ContributorStat => ({
  author: login === null ? null : { login },
  total,
  weeks: [
    {
      w: 1_700_000_000,
      a: lines?.additions ?? 0,
      c: total,
      d: lines?.deletions ?? 0,
    },
  ],
});

/** Builds a repo whose commit totals are `totals`, with line data present. */
const repoWithLines = (totals: readonly number[]): ContributorStat[] =>
  totals.map((total, i) =>
    contributor(`author-${i}`, total, {
      additions: total * 10,
      deletions: total * 2,
    }),
  );

/** Builds a repo where GitHub returned no line statistics (all a/d zero). */
const repoWithoutLines = (totals: readonly number[]): ContributorStat[] =>
  totals.map((total, i) => contributor(`author-${i}`, total));

const filler = (count: number, each: number): number[] =>
  Array.from({ length: count }, () => each);

const asOk = (result: ReturnType<typeof computeTruckFactor>) => {
  if (result.kind !== "ok") {
    throw new Error(`expected ok result, got ${result.kind}`);
  }
  return result;
};

const percent = (share: number): number => Math.round(share * 100);

describe("computeTruckFactor", () => {
  describe("verified repository shapes", () => {
    it("reports yargs-shaped data as truck factor 7, top author 27%", () => {
      // 270 + 6x45 = 540 crosses 500; six authors reach only 495.
      const stats = repoWithLines([270, 45, 45, 45, 45, 45, 45, ...filler(46, 10)]);

      const result = asOk(computeTruckFactor(stats));

      expect(result.truckFactor).toBe(7);
      expect(result.topAuthor.login).toBe("author-0");
      expect(percent(result.topAuthor.share)).toBe(27);
    });

    it("reports axios-shaped data as truck factor 2, top author 39%", () => {
      const stats = repoWithLines([390, 200, ...filler(41, 10)]);

      const result = asOk(computeTruckFactor(stats));

      expect(result.truckFactor).toBe(2);
      expect(percent(result.topAuthor.share)).toBe(39);
    });

    it("reports express-shaped data as truck factor 1, top author 66%", () => {
      const stats = repoWithLines([660, ...filler(34, 10)]);

      const result = asOk(computeTruckFactor(stats));

      expect(result.truckFactor).toBe(1);
      expect(percent(result.topAuthor.share)).toBe(66);
    });

    it("reports chalk-shaped data as truck factor 1, top author 60%", () => {
      const stats = repoWithLines([600, ...filler(40, 10)]);

      const result = asOk(computeTruckFactor(stats));

      expect(result.truckFactor).toBe(1);
      expect(percent(result.topAuthor.share)).toBe(60);
    });

    it("reports lodash-shaped data as truck factor 1, top author 89%", () => {
      const stats = repoWithLines([890, ...filler(11, 10)]);

      const result = asOk(computeTruckFactor(stats));

      expect(result.truckFactor).toBe(1);
      expect(percent(result.topAuthor.share)).toBe(89);
    });
  });

  describe("edge case: zeroed line data (facebook/react)", () => {
    it("still produces a commit truck factor of 6 with a 10% top author", () => {
      const stats = repoWithoutLines([
        100, 95, 90, 85, 80, 75,
        ...filler(19, 25),
      ]);

      const result = asOk(computeTruckFactor(stats));

      expect(result.truckFactor).toBe(6);
      expect(percent(result.topAuthor.share)).toBe(10);
    });

    it("marks the line signal unavailable rather than reporting zero", () => {
      const stats = repoWithoutLines([100, 95, 90, 85, 80, 75, ...filler(19, 25)]);

      const result = asOk(computeTruckFactor(stats));

      expect(result.lines.available).toBe(false);
      // The union has no numeric members when unavailable, so a caller cannot
      // read a zero as if it were a real line-based truck factor.
      expect(result.lines).toEqual({
        available: false,
        reason: "no-line-data",
      });
      expect(Object.values(result.lines)).not.toContain(0);
    });

    it("exposes the line signal when line data is present", () => {
      const stats = repoWithLines([890, ...filler(11, 10)]);

      const result = asOk(computeTruckFactor(stats));

      if (!result.lines.available) throw new Error("expected line data");
      expect(result.lines.truckFactor).toBe(1);
      expect(result.lines.netLines).toBe(890 * 8 + 11 * 10 * 8);
      expect(percent(result.lines.topAuthorShare)).toBe(89);
    });

    it("treats line data that nets to zero overall as unavailable", () => {
      // Every author added exactly what they deleted: no usable signal.
      const stats = [
        contributor("a", 10, { additions: 50, deletions: 50 }),
        contributor("b", 5, { additions: 20, deletions: 20 }),
      ];

      const result = asOk(computeTruckFactor(stats));

      expect(result.truckFactor).toBe(1);
      expect(result.lines.available).toBe(false);
    });
  });

  describe("edge case: contributor truncation", () => {
    it("reports an exact author count below the 100-contributor cap", () => {
      const stats = repoWithLines(filler(58, 10));

      const result = asOk(computeTruckFactor(stats));

      expect(result.authorCount).toEqual({ kind: "exact", value: 58 });
    });

    it("reports an approximate author count at the 100-contributor cap", () => {
      const stats = repoWithLines(filler(100, 10));

      const result = asOk(computeTruckFactor(stats));

      expect(result.authorCount).toEqual({ kind: "at-least", value: 100 });
    });

    it("reports an approximate author count at the 500-contributor cap", () => {
      const stats = repoWithLines(filler(500, 10));

      const result = asOk(computeTruckFactor(stats));

      expect(result.authorCount).toEqual({ kind: "at-least", value: 500 });
      // Truncation cannot move the truck factor: authors outside the returned
      // set are all smaller than those inside it.
      expect(result.truckFactor).toBe(250);
    });
  });

  describe("edge case: null authors", () => {
    /**
     * GitHub returns `author: null` for commits it cannot map to an account
     * (deleted users, unmatched commit emails). Such an entry is not a person
     * anyone could lose, so it is excluded from the ranking *and* from the
     * commit denominator — counting it in the denominator would understate
     * concentration among the people who actually exist. The commits are
     * reported separately as `unattributedCommits` so the omission is visible.
     */
    it("excludes unattributed commits from the ranking and the denominator", () => {
      const stats = [
        contributor("solo", 60, { additions: 600, deletions: 0 }),
        contributor(null, 400, { additions: 4000, deletions: 0 }),
        contributor("other", 40, { additions: 400, deletions: 0 }),
      ];

      const result = asOk(computeTruckFactor(stats));

      expect(result.truckFactor).toBe(1);
      expect(result.totalCommits).toBe(100);
      expect(percent(result.topAuthor.share)).toBe(60);
      expect(result.unattributedCommits).toBe(400);
      expect(result.authorCount).toEqual({ kind: "exact", value: 2 });
    });

    it("reports no attributable authors when every author is null", () => {
      const stats = [contributor(null, 100), contributor(null, 50)];

      const result = computeTruckFactor(stats);

      expect(result).toEqual({ kind: "unavailable", reason: "no-authors" });
    });
  });

  describe("edge case: empty and zero-commit input", () => {
    it("returns an explicit unavailable result for an empty array", () => {
      expect(computeTruckFactor([])).toEqual({
        kind: "unavailable",
        reason: "no-authors",
      });
    });

    it("returns an explicit unavailable result when all commit totals are zero", () => {
      const stats = [contributor("a", 0), contributor("b", 0)];

      expect(computeTruckFactor(stats)).toEqual({
        kind: "unavailable",
        reason: "no-commits",
      });
    });

    it("never reports a truck factor of zero", () => {
      const result = computeTruckFactor([contributor("only", 1)]);

      expect(asOk(result).truckFactor).toBe(1);
    });
  });

  describe("ranking", () => {
    it("ranks by commits even when line data disagrees", () => {
      // `churner` has more net lines but fewer commits; commits win (ADR-0001).
      const stats = [
        contributor("committer", 80, { additions: 100, deletions: 0 }),
        contributor("churner", 20, { additions: 10_000, deletions: 0 }),
      ];

      const result = asOk(computeTruckFactor(stats));

      expect(result.topAuthor.login).toBe("committer");
      expect(result.truckFactor).toBe(1);
      if (!result.lines.available) throw new Error("expected line data");
      expect(result.lines.truckFactor).toBe(1);
      expect(result.lines.topAuthorShare).toBeCloseTo(10_000 / 10_100);
    });

    it("does not mutate the input array", () => {
      const stats = repoWithLines([10, 900, 90]);
      const snapshot = structuredClone(stats);

      computeTruckFactor(stats);

      expect(stats).toEqual(snapshot);
    });

    it("ignores authors whose net lines are negative when scoring lines", () => {
      const stats = [
        contributor("builder", 10, { additions: 1000, deletions: 100 }),
        contributor("deleter", 9, { additions: 10, deletions: 500 }),
      ];

      const result = asOk(computeTruckFactor(stats));

      if (!result.lines.available) throw new Error("expected line data");
      expect(result.lines.truckFactor).toBe(1);
      expect(result.lines.netLines).toBe(900);
    });
  });
});
