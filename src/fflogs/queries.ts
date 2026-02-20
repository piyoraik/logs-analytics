export const REPORT_FIGHTS_QUERY = `
query ReportFights($code: String!) {
  reportData {
    report(code: $code) {
      code
      fights {
        id
        encounterID
        name
        kill
        startTime
        endTime
        difficulty
      }
    }
  }
}`;

export const REPORT_FIGHTS_QUERY_TRANSLATED = `
query ReportFightsTranslated($code: String!, $translate: Boolean) {
  reportData {
    report(code: $code, translate: $translate) {
      code
      fights {
        id
        encounterID
        name
        kill
        startTime
        endTime
        difficulty
      }
    }
  }
}`;

export const REPORT_MASTER_DATA_QUERY = `
query ReportMasterData($code: String!) {
  reportData {
    report(code: $code) {
      masterData {
        actors {
          id
          gameID
          name
          type
          subType
          petOwner
        }
        abilities {
          gameID
          name
        }
      }
    }
  }
}`;

export const REPORT_MASTER_DATA_QUERY_TRANSLATED = `
query ReportMasterDataTranslated($code: String!, $translate: Boolean) {
  reportData {
    report(code: $code, translate: $translate) {
      masterData {
        actors {
          id
          gameID
          name
          type
          subType
          petOwner
        }
        abilities {
          gameID
          name
        }
      }
    }
  }
}`;

export const REPORT_CASTS_QUERY = `
query ReportCasts(
  $code: String!
  $fightIDs: [Int!]
  $startTime: Float
  $endTime: Float
  $limit: Int
  $dataType: EventDataType
) {
  reportData {
    report(code: $code) {
      events(
        fightIDs: $fightIDs
        startTime: $startTime
        endTime: $endTime
        limit: $limit
        dataType: $dataType
      ) {
        data
        nextPageTimestamp
      }
    }
  }
}`;

export const REPORT_CASTS_QUERY_TRANSLATED = `
query ReportCastsTranslated(
  $code: String!
  $fightIDs: [Int!]
  $startTime: Float
  $endTime: Float
  $limit: Int
  $dataType: EventDataType
  $translate: Boolean
) {
  reportData {
    report(code: $code, translate: $translate) {
      events(
        fightIDs: $fightIDs
        startTime: $startTime
        endTime: $endTime
        limit: $limit
        dataType: $dataType
      ) {
        data
        nextPageTimestamp
      }
    }
  }
}`;

export const CHARACTER_RANKINGS_QUERY = `
query CharacterRankings(
  $encounterID: Int!
  $metric: CharacterRankingMetricType!
  $difficulty: Int
  $size: Int
  $partition: Int
) {
  worldData {
    encounter(id: $encounterID) {
      characterRankings(
        metric: $metric
        difficulty: $difficulty
        size: $size
        partition: $partition
      )
    }
  }
}`;

export const CHARACTER_RANKINGS_QUERY_METRIC_ONLY = `
query CharacterRankingsMetricOnly(
  $encounterID: Int!
  $metric: CharacterRankingMetricType!
) {
  worldData {
    encounter(id: $encounterID) {
      characterRankings(
        metric: $metric
      )
    }
  }
}`;

export const WORLD_ZONES_QUERY = `
query WorldZones {
  worldData {
    zones {
      id
      name
      encounters {
        id
        name
      }
    }
  }
}`;
