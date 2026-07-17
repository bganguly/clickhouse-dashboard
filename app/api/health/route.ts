import { NextResponse } from 'next/server';
import { ch } from '@/lib/clickhouse';

export async function GET() {
  ch.query({ query: 'SELECT 1', format: 'JSONEachRow' }).then(rs => rs.json()).catch(() => {});
  return NextResponse.json({ status: 'ok' }, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
    },
  });
}
