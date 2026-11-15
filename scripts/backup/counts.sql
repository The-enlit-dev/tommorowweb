-- Exact row count of every table in the app schemas: schema<TAB>table<TAB>rows
select table_schema, table_name,
  (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint
from information_schema.tables
where table_schema in ('public', 'private') and table_type = 'BASE TABLE'
order by 1, 2;
