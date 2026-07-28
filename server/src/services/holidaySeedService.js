import { Holiday } from '../models/Holiday.js';
import { parseDateInputAsISTDay } from '../utils/istDate.js';

/**
 * India company holiday list based on Central Government DoPT gazetted + restricted lists.
 * Sources: DoPT O.M. F.No.12/2/2023-JCA (2026 dated 03-07-2025; 2027 dated 16-07-2026).
 * Dates are IST calendar days. Islamic festival dates may shift with moon sighting.
 */
export const INDIA_COMPANY_HOLIDAYS = {
  2026: [
    // Gazetted (public)
    { date: '2026-01-26', name: 'Republic Day', type: 'public' },
    { date: '2026-03-04', name: 'Holi', type: 'public' },
    { date: '2026-03-21', name: 'Id-ul-Fitr', type: 'public' },
    { date: '2026-03-26', name: 'Ram Navami', type: 'public' },
    { date: '2026-03-31', name: 'Mahavir Jayanti', type: 'public' },
    { date: '2026-04-03', name: 'Good Friday', type: 'public' },
    { date: '2026-05-01', name: 'Buddha Purnima', type: 'public' },
    { date: '2026-05-27', name: 'Id-ul-Zuha (Bakrid)', type: 'public' },
    { date: '2026-06-26', name: 'Muharram', type: 'public' },
    { date: '2026-08-15', name: 'Independence Day', type: 'public' },
    { date: '2026-08-26', name: 'Id-e-Milad (Milad-un-Nabi)', type: 'public' },
    { date: '2026-09-04', name: 'Janmashtami', type: 'public' },
    { date: '2026-10-02', name: 'Gandhi Jayanti', type: 'public' },
    { date: '2026-10-20', name: 'Dussehra (Vijayadashami)', type: 'public' },
    { date: '2026-11-08', name: 'Diwali (Deepavali)', type: 'public' },
    { date: '2026-11-24', name: 'Guru Nanak Jayanti', type: 'public' },
    { date: '2026-12-25', name: 'Christmas', type: 'public' },
    // Restricted (commonly observed optional holidays)
    { date: '2026-01-01', name: "New Year's Day", type: 'restricted' },
    { date: '2026-01-14', name: 'Makar Sankranti / Pongal', type: 'restricted' },
    { date: '2026-01-23', name: 'Basant Panchami', type: 'restricted' },
    { date: '2026-02-15', name: 'Maha Shivratri', type: 'restricted' },
    { date: '2026-03-03', name: 'Holika Dahan', type: 'restricted' },
    { date: '2026-03-19', name: 'Ugadi / Gudi Padava', type: 'restricted' },
    { date: '2026-04-05', name: 'Easter Sunday', type: 'restricted' },
    { date: '2026-04-14', name: 'Ambedkar Jayanti', type: 'restricted' },
    { date: '2026-04-15', name: 'Vaisakhadi (Bahag Bihu)', type: 'restricted' },
    { date: '2026-07-16', name: 'Rath Yatra', type: 'restricted' },
    { date: '2026-08-28', name: 'Raksha Bandhan', type: 'restricted' },
    { date: '2026-09-14', name: 'Ganesh Chaturthi', type: 'restricted' },
    { date: '2026-10-29', name: 'Karva Chauth', type: 'restricted' },
    { date: '2026-11-09', name: 'Govardhan Puja', type: 'restricted' },
    { date: '2026-11-11', name: 'Bhai Duj', type: 'restricted' },
    { date: '2026-11-15', name: 'Chhath Puja', type: 'restricted' },
  ],
  2027: [
    // Gazetted (public)
    { date: '2027-01-26', name: 'Republic Day', type: 'public' },
    { date: '2027-03-10', name: 'Id-ul-Fitr', type: 'public' },
    { date: '2027-03-23', name: 'Holi', type: 'public' },
    { date: '2027-03-26', name: 'Good Friday', type: 'public' },
    { date: '2027-04-15', name: 'Ram Navami', type: 'public' },
    { date: '2027-04-19', name: 'Mahavir Jayanti', type: 'public' },
    { date: '2027-05-17', name: 'Id-ul-Zuha (Bakrid)', type: 'public' },
    { date: '2027-05-20', name: 'Buddha Purnima', type: 'public' },
    { date: '2027-06-16', name: 'Muharram', type: 'public' },
    { date: '2027-08-15', name: 'Independence Day', type: 'public' },
    { date: '2027-08-25', name: 'Janmashtami', type: 'public' },
    { date: '2027-10-02', name: 'Gandhi Jayanti', type: 'public' },
    { date: '2027-10-09', name: 'Dussehra (Vijayadashami)', type: 'public' },
    { date: '2027-10-29', name: 'Diwali (Deepavali)', type: 'public' },
    { date: '2027-11-14', name: 'Guru Nanak Jayanti', type: 'public' },
    { date: '2027-12-25', name: 'Christmas', type: 'public' },
    // Restricted (commonly observed optional holidays)
    { date: '2027-01-01', name: "New Year's Day", type: 'restricted' },
    { date: '2027-01-14', name: 'Makar Sankranti / Magha Bihu', type: 'restricted' },
    { date: '2027-01-15', name: 'Pongal', type: 'restricted' },
    { date: '2027-02-11', name: 'Basant Panchami', type: 'restricted' },
    { date: '2027-03-06', name: 'Maha Shivratri', type: 'restricted' },
    { date: '2027-03-22', name: 'Holika Dahan', type: 'restricted' },
    { date: '2027-03-28', name: 'Easter Sunday', type: 'restricted' },
    { date: '2027-04-07', name: 'Ugadi / Gudi Padava', type: 'restricted' },
    { date: '2027-04-14', name: 'Ambedkar Jayanti', type: 'restricted' },
    { date: '2027-07-05', name: 'Rath Yatra', type: 'restricted' },
    { date: '2027-08-17', name: 'Raksha Bandhan', type: 'restricted' },
    { date: '2027-09-04', name: 'Ganesh Chaturthi', type: 'restricted' },
    { date: '2027-09-12', name: 'Onam', type: 'restricted' },
    { date: '2027-10-28', name: 'Naraka Chaturdasi', type: 'restricted' },
    { date: '2027-10-30', name: 'Govardhan Puja', type: 'restricted' },
    { date: '2027-10-31', name: 'Bhai Duj', type: 'restricted' },
    { date: '2027-11-04', name: 'Chhath Puja', type: 'restricted' },
  ],
};

export function getSeedYears() {
  return [2026, 2027];
}

export async function seedIndiaHolidays({ years = getSeedYears(), actorId = null } = {}) {
  const summary = { created: 0, updated: 0, skipped: 0, years: {} };

  for (const year of years) {
    const entries = INDIA_COMPANY_HOLIDAYS[year];
    if (!entries?.length) {
      summary.years[year] = { created: 0, updated: 0, skipped: 0, missing: true };
      continue;
    }

    const yearSummary = { created: 0, updated: 0, skipped: 0 };

    for (const entry of entries) {
      const date = parseDateInputAsISTDay(entry.date);
      const existing = await Holiday.findOne({ date });

      if (existing) {
        if (existing.name === entry.name && existing.type === entry.type) {
          yearSummary.skipped += 1;
          summary.skipped += 1;
          continue;
        }
        existing.name = entry.name;
        existing.type = entry.type;
        existing.isActive = true;
        await existing.save();
        yearSummary.updated += 1;
        summary.updated += 1;
        continue;
      }

      await Holiday.create({
        date,
        name: entry.name,
        type: entry.type,
        isActive: true,
        createdBy: actorId,
      });
      yearSummary.created += 1;
      summary.created += 1;
    }

    summary.years[year] = yearSummary;
  }

  return summary;
}
