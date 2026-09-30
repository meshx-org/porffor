-- wrk: POST a 1 KB body (bench/server/run.mjs's echo scenario)
wrk.method = "POST"
wrk.body = string.rep("a", 1024)
wrk.headers["Content-Type"] = "text/plain"
