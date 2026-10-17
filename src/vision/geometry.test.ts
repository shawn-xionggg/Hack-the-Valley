import { describe, expect, it } from "vitest";
import type { Polygon, ZoneLayout } from "../shared/config";
import { isSimplePolygon, overlappingZones, polygonArea, polygonsOverlap, segmentsIntersect, validatePolygon } from "./geometry";

const square: Polygon = [[0.1, 0.1], [0.4, 0.1], [0.4, 0.4], [0.1, 0.4]];
const bowtie: Polygon = [[0.1, 0.1], [0.4, 0.4], [0.4, 0.1], [0.1, 0.4]];
const shift = (polygon: Polygon, dx: number, dy: number): Polygon => polygon.map(([x, y]) => [x + dx, y + dy]);

describe("calibration geometry", () => {
  it("measures area regardless of winding order", () => {
    expect(polygonArea(square)).toBeCloseTo(0.09);
    expect(polygonArea([...square].reverse())).toBeCloseTo(0.09);
    expect(polygonArea([[0, 0], [1, 0], [0, 1]])).toBeCloseTo(0.5);
    expect(polygonArea([[0.1, 0.1], [0.2, 0.2], [0.3, 0.3]])).toBe(0); // collinear
  });

  it("detects crossing, touching and collinear-overlapping segments", () => {
    expect(segmentsIntersect([0, 0], [1, 1], [0, 1], [1, 0])).toBe(true);
    expect(segmentsIntersect([0, 0], [1, 0], [0, 1], [1, 1])).toBe(false); // parallel
    expect(segmentsIntersect([0, 0], [1, 0], [1, 0], [1, 1])).toBe(true); // shared endpoint
    expect(segmentsIntersect([0, 0], [2, 0], [1, 0], [3, 0])).toBe(true); // collinear overlap
    expect(segmentsIntersect([0, 0], [1, 0], [2, 0], [3, 0])).toBe(false); // collinear, apart
  });

  it("rejects bowties, repeated vertices and too few points", () => {
    expect(isSimplePolygon(square)).toBe(true);
    expect(isSimplePolygon([[0.1, 0.1], [0.4, 0.1], [0.2, 0.4]])).toBe(true);
    expect(isSimplePolygon(bowtie)).toBe(false);
    expect(isSimplePolygon([[0.1, 0.1], [0.4, 0.1], [0.4, 0.1], [0.4, 0.4]])).toBe(false);
    expect(isSimplePolygon([[0.1, 0.1], [0.4, 0.1]])).toBe(false);
  });

  it("treats crossing, touching or nested zones as overlapping", () => {
    expect(polygonsOverlap(square, shift(square, 0.5, 0))).toBe(false);
    expect(polygonsOverlap(square, shift(square, 0.15, 0.15))).toBe(true);
    expect(polygonsOverlap(square, shift(square, 0.3, 0))).toBe(true); // shared edge: no hinge gap
    expect(polygonsOverlap(square, [[0.2, 0.2], [0.3, 0.2], [0.3, 0.3], [0.2, 0.3]])).toBe(true); // nested
    expect(polygonsOverlap(square, [])).toBe(false);
  });

  it("lists each overlapping pair of zones once and ignores unset zones", () => {
    const layout: ZoneLayout = {
      "peanut-source": shift(square, 0.5, 0.5),
      "tongs-tip": square,
      "tongs-handle": shift(square, 0.2, 0), // overlaps the tip: no hinge gap
      "meal-1": [],
      "wash-station": shift(square, 0.5, 0.5), // drawn on top of the peanut source
    };
    expect(overlappingZones(layout)).toEqual([["peanut-source", "wash-station"], ["tongs-tip", "tongs-handle"]]);
    expect(overlappingZones({ ...layout, "tongs-handle": shift(square, 0.35, 0), "wash-station": [] })).toEqual([]);
  });

  it("accepts sensible zones and explains why bad ones are rejected", () => {
    expect(validatePolygon(square)).toBeNull();
    expect(validatePolygon([[0.1, 0.1], [0.4, 0.1]])).toMatch(/3 corners/);
    expect(validatePolygon(bowtie)).toMatch(/cross/); // crossing wins over its near-zero area
    expect(validatePolygon([[0.1, 0.1], [0.11, 0.1], [0.11, 0.11], [0.1, 0.11]])).toMatch(/too small/); // 0.0001
    expect(validatePolygon([[0, 0], [1, 0], [1, 0.9], [0, 0.9]])).toMatch(/half the frame/);
  });
});
