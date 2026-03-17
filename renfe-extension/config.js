// ============================================================
// TRIP CONFIGURATION
// ============================================================
// Station names and search strings for each leg of the trip.
// The extension always books Hellín ↔ Albacete-Los Llanos.
//
// searchText: what to type into the autocomplete input
//             (enough characters to filter to a unique match)
// stationName: the exact text that appears in the autocomplete
//              dropdown item (used to verify the right one is clicked)
// ============================================================

const CONFIG = {
  go: {
    origin: {
      searchText: 'helli',
      stationName: 'HELLÍN'
    },
    destination: {
      searchText: 'albace',
      stationName: 'ALBACETE-LOS LLANOS'
    }
  },
  return: {
    origin: {
      searchText: 'albace',
      stationName: 'ALBACETE-LOS LLANOS'
    },
    destination: {
      searchText: 'helli',
      stationName: 'HELLÍN'
    }
  }
};

if (typeof window !== 'undefined') {
  window.RENFE_CONFIG = CONFIG;
}
