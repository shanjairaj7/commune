// Types based on Qdrant API documentation
export interface MatchValue {
  value: string | number | boolean;
}

export interface MatchAny {
  any: (string | number | boolean)[];
}

export interface RangeCondition {
  gt?: string | number;
  gte?: string | number;
  lt?: string | number;
  lte?: string | number;
}

export interface FieldCondition {
  key: string;
  match?: MatchValue | MatchAny;
  range?: RangeCondition;
}

export interface FilterCondition {
  must?: FieldCondition[];
  should?: FieldCondition[];
  must_not?: FieldCondition[];
}
