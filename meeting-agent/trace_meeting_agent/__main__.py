import argparse
import importlib
import logging
import os

parser = argparse.ArgumentParser(description="Run a Trace meeting agent on localhost")
parser.add_argument("module", help="Python module exporting an agent")
parser.add_argument("--port", type=int, default=8090)
parser.add_argument("--database", default=".state/meeting-events.sqlite")
args = parser.parse_args()
logging.basicConfig(level=logging.INFO)
agent = importlib.import_module(args.module).agent
try:
    agent.configure(
        database=args.database,
        api_key=os.environ["MEETSTREAM_API_KEY"],
        signing_secret=os.environ["TRACE_MEETING_AGENT_SIGNING_SECRET"],
        live_token=os.environ["TRACE_MEETING_AGENT_LIVE_TOKEN"],
        agent_id=os.environ["TRACE_MEETING_AGENT_ID"],
    )
except (KeyError, ValueError) as error:
    parser.error(str(error))
logging.info("Meeting agent listening on 127.0.0.1:%d", args.port)
try:
    agent.serve(port=args.port)
except KeyboardInterrupt:
    pass
