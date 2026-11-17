from fastapi import Request


def ok(request: Request, data):
    return {"data": data, "meta": {"request_id": request.state.request_id, "api_version": "v1"}}